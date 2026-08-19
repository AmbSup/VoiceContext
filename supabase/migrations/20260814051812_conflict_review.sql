-- Conflict-aware Memory Extraction, scalable variant (see
-- docs/implementation-plan.md roadmap: "Extraktionspipeline entlasten" —
-- step 2 of the post-review roadmap, building on Hybrid Retrieval
-- (0013_hybrid_retrieval.sql)). The old single-shot design
-- (web/src/lib/pipeline.ts, ADR 0002) loaded every active Memory-Item into
-- the extraction prompt to let the model spot contradictions inline — that
-- scales with total memory, not with what changed. The new pipeline
-- extracts first, then asks per new item: "what few *aktive* existing items
-- could this conflict with?", via Hybrid Retrieval instead of a full table
-- scan in the prompt.

-- match_conflict_candidates mirrors match_memory_items
-- (0013_hybrid_retrieval.sql) almost exactly — same RRF fusion of vector
-- similarity and 'simple'-config full-text search, same params-CTE
-- hardening (query_text clamped to 500 chars, rrf_k clamped to [1,100],
-- match_count clamped to [1,30] with the candidate pool capped at 60,
-- null query_embedding handled gracefully for a failed embedding call) —
-- but as its own function rather than a match_memory_items parameter,
-- because status = 'aktiv' has to be part of the *pre-ranking* candidates
-- CTE to be a reliable filter. Filtering match_memory_items' output
-- afterwards could silently return fewer than match_count real candidates,
-- since that pool is already capped before such a filter would run.
-- Deliberately no type/context/date filters: a conflict can legitimately
-- span types (a new 'entscheidung' superseding an old 'offene_frage') or
-- Kontexte, so only context_space_id and status should narrow the set.
create or replace function public.match_conflict_candidates(
  query_embedding vector(1536),
  query_text text,
  match_context_space_id uuid,
  match_count int default 8,
  rrf_k int default 50
)
returns table (
  id uuid,
  type text,
  content text,
  status text,
  confidence text,
  occurred_at timestamptz,
  similarity float8,
  fts_rank float8,
  fused_score float8
)
language sql
stable
set search_path = 'public'
as $$
  with params as (
    select
      left(coalesce(query_text, ''), 500) as query_text,
      least(greatest(coalesce(rrf_k, 50), 1), 100) as rrf_k
  ),
  candidates as (
    select m.*
    from public.memory_items m
    where m.context_space_id = match_context_space_id
      and m.status = 'aktiv'
  ),
  semantic as (
    select
      id,
      row_number() over (order by embedding <=> query_embedding) as rank_ix,
      1 - (embedding <=> query_embedding) as similarity
    from candidates
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
    c.type,
    c.content,
    c.status,
    c.confidence,
    c.occurred_at,
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

revoke all on function public.match_conflict_candidates(vector, text, uuid, int, int) from public;
grant execute on function public.match_conflict_candidates(vector, text, uuid, int, int) to authenticated;

-- Holds an uncertain conflict verdict (confidence below 'hoch', or any
-- 'widerspruch' — a genuine contradiction needs a human to decide which
-- side is actually current, auto-resolving isn't safe) between a
-- newly-extracted memory item and an existing active one, pending
-- confirmation on /inbox. High-confidence 'duplikat'/'ersetzt_veraltet'
-- verdicts are applied directly (existing item -> ueberholt) and never
-- create a row here. At most one open row per new_memory_item_id: the
-- conflict classifier in web/src/lib/pipeline.ts picks at most one related
-- existing item per new item, not one verdict per candidate.
create table memory_conflict_reviews (
  id uuid primary key default gen_random_uuid(),
  context_space_id uuid not null references context_spaces (id) on delete cascade,
  new_memory_item_id uuid not null references memory_items (id) on delete cascade,
  existing_memory_item_id uuid not null references memory_items (id) on delete cascade,
  verdict text not null check (verdict in ('duplikat', 'widerspruch', 'ersetzt_veraltet')),
  confidence text not null check (confidence in ('niedrig', 'mittel', 'hoch')),
  status text not null default 'offen' check (status in ('offen', 'bestaetigt', 'verworfen')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles (id)
);

create index memory_conflict_reviews_context_space_idx
  on memory_conflict_reviews (context_space_id);
create index memory_conflict_reviews_new_item_idx
  on memory_conflict_reviews (new_memory_item_id);
create index memory_conflict_reviews_existing_item_idx
  on memory_conflict_reviews (existing_memory_item_id);
create index memory_conflict_reviews_resolved_by_idx
  on memory_conflict_reviews (resolved_by);

alter table memory_conflict_reviews enable row level security;

create policy "member access" on memory_conflict_reviews for all
  to authenticated
  using (
    context_space_id in (
      select context_space_id from context_space_members where user_id = (select auth.uid())
    )
  );
