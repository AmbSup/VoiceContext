-- Hybrid Retrieval (see docs/implementation-plan.md roadmap: "Hybrid
-- Retrieval einführen" — step 1 of the post-review roadmap). Pure
-- embedding-cosine ranking (0010_match_memory_items.sql,
-- 0011_context_embeddings.sql) is unreliable for names, exact phrases,
-- dates and other low-semantic-overlap-but-exact-match content. This adds
-- Postgres full-text search alongside the existing vector search, fused via
-- Reciprocal Rank Fusion (RRF) — the standard Supabase hybrid-search
-- pattern, see .agents/skills/supabase-postgres-best-practices/references/
-- advanced-full-text-search.md. The final relevance judgment (mindestscore
-- threshold, conservative relevance gate) happens app-side after an LLM
-- reranking pass over this function's candidate pool (see
-- web/src/lib/retrieval.ts) — this function only has to produce a good,
-- broad candidate set, not the final ranking, hence returning a pool larger
-- than match_count instead of match_count itself.
--
-- FTS uses the 'simple' text search config, not 'german': 'german' stems
-- words and drops stopwords, which helps natural-language phrasing but
-- actively hurts exactly the case this is for — proper names and product
-- numbers, where embeddings already cover the semantic side.
--
-- query_embedding is nullable: if the caller's embedding call failed, it
-- passes null rather than giving up on retrieval entirely — the semantic
-- CTE below then simply contributes nothing and FTS alone drives the fused
-- ranking, instead of the whole function erroring out.
--
-- Both RPCs are reachable directly via the Supabase Data API by any
-- authenticated user, not only through our own routes — every input is
-- therefore clamped/validated server-side rather than trusted from the
-- caller: match_count to [1,30] (candidate pools additionally capped at
-- 60), query_text to 500 chars (and treated as "no FTS leg" if empty after
-- trimming, rather than handing Postgres a degenerate tsquery), rrf_k to
-- [1,100], and match_memory_items' match_types intersected against the
-- actual 12 allowed values from memory_items' check constraint
-- (0001_init_schema.sql) so a bogus value can't even silently no-op its way
-- through — it's dropped before the filter runs.

alter table memory_items add column fts tsvector
  generated always as (to_tsvector('simple', coalesce(content, ''))) stored;

create index memory_items_fts_idx on memory_items using gin (fts);

alter table contexts add column fts tsvector
  generated always as (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, ''))
  ) stored;

create index contexts_fts_idx on contexts using gin (fts);

drop function if exists public.match_memory_items(vector, uuid, int);

-- Metadata filters (match_types, match_context_id, match_occurred_from/to)
-- cover the "Filter nach Kontext, Typ und Datum" gap — all optional/nullable
-- so existing callers passing only the original three params keep working
-- (Postgres matches by name here since every new param has a default).
-- status <> 'ueberholt' stays hardcoded, same reasoning as 0010: a
-- superseded item should never resurface via Retrieval, not even via an
-- explicit filter.
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
  fused_score float8
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
    -- match_count is a scalar function parameter, not a CTE column — a
    -- LIMIT clause can't reference the latter (42P10: "argument of LIMIT
    -- must not contain variables"), hence the inline clamp instead of
    -- reading the bounded value back out of `params`.
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

revoke all on function public.match_memory_items(
  vector, text, uuid, int, text[], uuid, timestamptz, timestamptz, int
) from public;
grant execute on function public.match_memory_items(
  vector, text, uuid, int, text[], uuid, timestamptz, timestamptz, int
) to authenticated;

drop function if exists public.match_contexts(vector, uuid, int);

-- Same RRF fusion as match_memory_items above, but no metadata filters —
-- contexts have no type/status/occurred_at to filter on.
create or replace function public.match_contexts(
  query_embedding vector(1536),
  query_text text,
  match_context_space_id uuid,
  match_count int default 5,
  rrf_k int default 50
)
returns table (
  id uuid,
  name text,
  description text,
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
    select c.*
    from public.contexts c
    where c.context_space_id = match_context_space_id
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
    c.name,
    c.description,
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

revoke all on function public.match_contexts(vector, text, uuid, int, int) from public;
grant execute on function public.match_contexts(vector, text, uuid, int, int) to authenticated;
