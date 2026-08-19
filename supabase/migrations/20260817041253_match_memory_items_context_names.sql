-- Adds context_names to match_memory_items so a caller can tell which
-- Kontext(e) each returned Memory-Item belongs to — needed for
-- retrieve_memory's new scope="context_space" mode (api/retrieve/route.ts):
-- a cross-cutting question like "In welchen Projekten arbeitet Person A?"
-- needs the model to see e.g. ["Projekt Haus", "Projekt Sportstudio"] per
-- item, not just its content. Memory-Items link to contexts many-to-many
-- via memory_context_links (0001_init_schema.sql), so this is an
-- aggregated subquery, not a plain join column — a memory_item with no
-- links (sits in the Inbox) gets an empty array, not null.

drop function if exists public.match_memory_items(
  vector, text, uuid, int, text[], uuid, timestamptz, timestamptz, int
);

create or replace function public.match_memory_items(
  query_embedding vector(1536),
  query_text text,
  match_context_space_id uuid,
  match_count int default 8,
  match_types text[] default null,
  match_context_id uuid default null,
  match_occurred_from timestamptz default null,
  match_occurred_to timestamptz default null,
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
  fused_score float8,
  context_names text[]
)
language sql
stable
set search_path = 'public'
as $$
  with params as (
    select
      left(coalesce(query_text, ''), 500) as query_text,
      least(greatest(coalesce(rrf_k, 50), 1), 100) as rrf_k,
      case
        when match_types is null then null
        else array(
          select unnest(match_types)
          intersect
          select unnest(array[
            'fakt', 'entscheidung', 'aufgabe', 'idee', 'annahme', 'offene_frage',
            'ziel', 'risiko', 'person', 'termin', 'ergebnis', 'erkenntnis'
          ])
        )
      end as match_types
  ),
  candidates as (
    select m.*
    from public.memory_items m, params
    where m.context_space_id = match_context_space_id
      and m.status <> 'ueberholt'
      and (params.match_types is null or m.type = any(params.match_types))
      and (match_occurred_from is null or m.occurred_at >= match_occurred_from)
      and (match_occurred_to is null or m.occurred_at <= match_occurred_to)
      and (
        match_context_id is null
        or exists (
          select 1 from public.memory_context_links l
          where l.memory_item_id = m.id and l.context_id = match_context_id
        )
      )
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
      + coalesce(1.0 / (params.rrf_k + full_text.rank_ix), 0.0) as fused_score,
    coalesce(
      (
        select array_agg(ctx.name order by ctx.name)
        from public.memory_context_links l
        join public.contexts ctx on ctx.id = l.context_id
        where l.memory_item_id = c.id
      ),
      array[]::text[]
    ) as context_names
  from full_text
  full outer join semantic on semantic.id = full_text.id
  join candidates c on c.id = coalesce(full_text.id, semantic.id)
  cross join params
  order by fused_score desc
  limit least(greatest(least(greatest(match_count, 1), 30) * 3, 15), 60);
$$;

revoke all on function public.match_memory_items(
  vector, text, uuid, int, text[], uuid, timestamptz, timestamptz, int
) from public;
grant execute on function public.match_memory_items(
  vector, text, uuid, int, text[], uuid, timestamptz, timestamptz, int
) to authenticated;
