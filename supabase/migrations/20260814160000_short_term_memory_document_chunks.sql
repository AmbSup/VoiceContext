-- Four-level memory architecture:
--   current Realtime turns -> short-term session memory -> segments/items
--   -> verbatim document chunks for detailed retrieval.
--
-- This follows the existing imperative-migration workflow. All public data
-- remains protected by the same Context-Space membership model as the rest
-- of the schema, and all retrieval functions stay SECURITY INVOKER.

-- A compact, structured hand-off generated after a voice session. The raw
-- transcript remains the source of truth in full_transcript; this note is a
-- bounded convenience layer for the next Realtime session.
alter table public.dialog_sessions
  add column short_term_memory jsonb,
  add column short_term_memory_token_count integer,
  add column short_term_memory_generated_at timestamptz,
  add constraint dialog_sessions_short_term_memory_object_check
    check (
      short_term_memory is null
      or jsonb_typeof(short_term_memory) = 'object'
    ),
  add constraint dialog_sessions_short_term_memory_token_count_check
    check (
      short_term_memory_token_count is null
      or short_term_memory_token_count >= 0
    );

-- Preserve the explicit context chosen for a document and for generated
-- segments. Existing rows are backfilled only when their linked Memory-Items
-- identify exactly one context; ambiguous rows deliberately stay unscoped.
alter table public.documents
  add column context_id uuid references public.contexts (id) on delete set null;

alter table public.segments
  add column context_id uuid references public.contexts (id) on delete set null;

alter table public.documents
  add constraint documents_context_space_id_id_key
  unique (context_space_id, id);

create index documents_context_id_idx on public.documents (context_id);
create index segments_context_id_idx on public.segments (context_id);

with segment_context as (
  select
    mi.segment_id,
    min(mcl.context_id::text)::uuid as context_id
  from public.memory_items mi
  join public.memory_context_links mcl on mcl.memory_item_id = mi.id
  where mi.segment_id is not null
  group by mi.segment_id
  having count(distinct mcl.context_id) = 1
)
update public.segments s
set context_id = sc.context_id
from segment_context sc
where s.id = sc.segment_id
  and s.context_id is null;

with document_context as (
  select
    s.document_id,
    min(s.context_id::text)::uuid as context_id
  from public.segments s
  where s.document_id is not null
    and s.context_id is not null
  group by s.document_id
  having count(distinct s.context_id) = 1
)
update public.documents d
set context_id = dc.context_id
from document_context dc
where d.id = dc.document_id
  and d.context_id is null;

alter table public.documents
  add constraint documents_context_space_context_fkey
  foreign key (context_space_id, context_id)
  references public.contexts (context_space_id, id);

alter table public.segments
  add constraint segments_context_space_context_fkey
  foreign key (context_space_id, context_id)
  references public.contexts (context_space_id, id);

-- Verbatim, overlapping retrieval passages. These are deliberately separate
-- from LLM-authored segments: summaries may omit details, chunks may not.
create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  context_space_id uuid not null references public.context_spaces (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  context_id uuid references public.contexts (id) on delete set null,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (btrim(content) <> ''),
  token_count integer not null check (token_count > 0),
  embedding vector(1536),
  fts tsvector generated always as (
    to_tsvector('simple', coalesce(content, ''))
  ) stored,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index),
  constraint document_chunks_space_document_fkey
    foreign key (context_space_id, document_id)
    references public.documents (context_space_id, id),
  constraint document_chunks_space_context_fkey
    foreign key (context_space_id, context_id)
    references public.contexts (context_space_id, id)
);

create index document_chunks_context_space_id_idx
  on public.document_chunks (context_space_id);
create index document_chunks_document_id_idx
  on public.document_chunks (document_id);
create index document_chunks_context_id_idx
  on public.document_chunks (context_id);
create index document_chunks_embedding_idx
  on public.document_chunks using hnsw (embedding vector_cosine_ops);
create index document_chunks_fts_idx
  on public.document_chunks using gin (fts);

alter table public.document_chunks enable row level security;

create policy "member access" on public.document_chunks for all
  to authenticated
  using (
    context_space_id in (select private.user_context_space_ids())
  )
  with check (
    context_space_id in (select private.user_context_space_ids())
  );

grant select, insert, update, delete
  on table public.document_chunks
  to authenticated;

-- Scope segments to an active/explicit context without losing older rows:
-- direct context_id is preferred; existing segments can also inherit scope
-- through their linked Memory-Items.
drop function if exists public.match_segments(vector, text, uuid, int, int);

create function public.match_segments(
  query_embedding vector(1536),
  query_text text,
  match_context_space_id uuid,
  match_count int default 4,
  rrf_k int default 50,
  match_context_id uuid default null
)
returns table (
  id uuid,
  content text,
  source_type text,
  document_id uuid,
  dialog_session_id uuid,
  context_id uuid,
  created_at timestamptz,
  similarity float8,
  fts_rank float8,
  fused_score float8
)
language sql
stable
security invoker
set search_path = 'public'
as $$
  with params as (
    select
      left(coalesce(query_text, ''), 500) as query_text,
      least(greatest(coalesce(rrf_k, 50), 1), 100) as rrf_k
  ),
  candidates as (
    select s.*
    from public.segments s
    where s.context_space_id = match_context_space_id
      and (
        match_context_id is null
        or s.context_id = match_context_id
        or exists (
          select 1
          from public.memory_items mi
          join public.memory_context_links mcl on mcl.memory_item_id = mi.id
          where mi.segment_id = s.id
            and mcl.context_id = match_context_id
        )
      )
  ),
  semantic as (
    select
      id,
      row_number() over (order by embedding <=> query_embedding) as rank_ix,
      1 - (embedding <=> query_embedding) as similarity
    from candidates, params
    where query_embedding is not null and embedding is not null
    order by embedding <=> query_embedding
    limit least(greatest(least(greatest(match_count, 1), 30) * 4, 20), 60)
  ),
  full_text as (
    select
      c.id,
      row_number() over (
        order by ts_rank_cd(c.fts, websearch_to_tsquery('simple', params.query_text)) desc
      ) as rank_ix,
      ts_rank_cd(c.fts, websearch_to_tsquery('simple', params.query_text)) as fts_rank
    from candidates c, params
    where params.query_text <> ''
      and c.fts @@ websearch_to_tsquery('simple', params.query_text)
    order by rank_ix
    limit least(greatest(least(greatest(match_count, 1), 30) * 4, 20), 60)
  )
  select
    c.id,
    c.content,
    c.source_type,
    c.document_id,
    c.dialog_session_id,
    c.context_id,
    c.created_at,
    coalesce(semantic.similarity, 0) as similarity,
    coalesce(full_text.fts_rank, 0) as fts_rank,
    coalesce(1.0 / (params.rrf_k + semantic.rank_ix), 0.0)
      + coalesce(1.0 / (params.rrf_k + full_text.rank_ix), 0.0) as fused_score
  from full_text
  full outer join semantic on semantic.id = full_text.id
  join candidates c on c.id = coalesce(full_text.id, semantic.id)
  cross join params
  order by fused_score desc
  limit least(greatest(least(greatest(match_count, 1), 30) * 3, 15), 60);
$$;

revoke all on function public.match_segments(vector, text, uuid, int, int, uuid) from public;
grant execute on function public.match_segments(vector, text, uuid, int, int, uuid) to authenticated;

create function public.match_document_chunks(
  query_embedding vector(1536),
  query_text text,
  match_context_space_id uuid,
  match_count int default 6,
  rrf_k int default 50,
  match_context_id uuid default null
)
returns table (
  id uuid,
  document_id uuid,
  context_id uuid,
  file_name text,
  chunk_index integer,
  content text,
  created_at timestamptz,
  similarity float8,
  fts_rank float8,
  fused_score float8
)
language sql
stable
security invoker
set search_path = 'public'
as $$
  with params as (
    select
      left(coalesce(query_text, ''), 500) as query_text,
      least(greatest(coalesce(rrf_k, 50), 1), 100) as rrf_k
  ),
  candidates as (
    select dc.*
    from public.document_chunks dc
    where dc.context_space_id = match_context_space_id
      and (match_context_id is null or dc.context_id = match_context_id)
  ),
  semantic as (
    select
      id,
      row_number() over (order by embedding <=> query_embedding) as rank_ix,
      1 - (embedding <=> query_embedding) as similarity
    from candidates, params
    where query_embedding is not null and embedding is not null
    order by embedding <=> query_embedding
    limit least(greatest(least(greatest(match_count, 1), 30) * 4, 20), 60)
  ),
  full_text as (
    select
      c.id,
      row_number() over (
        order by ts_rank_cd(c.fts, websearch_to_tsquery('simple', params.query_text)) desc
      ) as rank_ix,
      ts_rank_cd(c.fts, websearch_to_tsquery('simple', params.query_text)) as fts_rank
    from candidates c, params
    where params.query_text <> ''
      and c.fts @@ websearch_to_tsquery('simple', params.query_text)
    order by rank_ix
    limit least(greatest(least(greatest(match_count, 1), 30) * 4, 20), 60)
  )
  select
    c.id,
    c.document_id,
    c.context_id,
    d.file_name,
    c.chunk_index,
    c.content,
    c.created_at,
    coalesce(semantic.similarity, 0) as similarity,
    coalesce(full_text.fts_rank, 0) as fts_rank,
    coalesce(1.0 / (params.rrf_k + semantic.rank_ix), 0.0)
      + coalesce(1.0 / (params.rrf_k + full_text.rank_ix), 0.0) as fused_score
  from full_text
  full outer join semantic on semantic.id = full_text.id
  join candidates c on c.id = coalesce(full_text.id, semantic.id)
  join public.documents d on d.id = c.document_id
  cross join params
  order by fused_score desc
  limit least(greatest(least(greatest(match_count, 1), 30) * 3, 15), 60);
$$;

revoke all on function public.match_document_chunks(vector, text, uuid, int, int, uuid) from public;
grant execute on function public.match_document_chunks(vector, text, uuid, int, int, uuid) to authenticated;
