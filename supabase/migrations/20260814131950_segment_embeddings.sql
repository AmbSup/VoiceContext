-- Make `segments` retrievable via Hybrid Retrieval as a third source,
-- alongside memory_items and contexts.
--
-- Until now `segments` (the topic-grouped, less-compressed rewrite the
-- extraction pipeline produces before distilling atomic memory_items out of
-- it — see pipeline.ts's buildSystemPrompt and 0001_init_schema.sql's
-- segments table) was write-only: nothing ever queried it back. A user
-- uploaded a ~4220-word document and only 9 short memory_items survived
-- extraction (by design — the extraction prompt deliberately keeps only
-- atomic facts/decisions/tasks/etc., discarding narrative detail). That
-- detail wasn't lost, though: it's sitting in `segments.content`, just
-- unreachable. This migration makes it searchable via the same
-- embedding+FTS Hybrid Retrieval mechanism already used for the other two
-- source kinds.
--
-- Mirrors match_contexts (the hardened version in
-- 0015_conflict_review_fixes.sql:122-195) as closely as possible: same RRF
-- fusion of pgvector cosine similarity + `simple`-config full-text search,
-- same params clamping, same pool/limit formulas, same hnsw index type
-- (confirmed as the index type used for both memory_items.embedding and
-- contexts.embedding — not ivfflat). No match_context_id parameter here:
-- a segment belongs to a document/dialog session, not a Kontext, so there's
-- nothing analogous to filter on.

alter table segments add column embedding vector(1536);

create index segments_embedding_idx on segments using hnsw (embedding vector_cosine_ops);

alter table segments
  add column fts tsvector generated always as (to_tsvector('simple', coalesce(content, ''))) stored;

create index segments_fts_idx on segments using gin (fts);

-- No RLS policy added here — segments already has the "member access"
-- policy from 0001_init_schema.sql:250-252, applying to all columns.

create or replace function public.match_segments(
  query_embedding vector(1536),
  query_text text,
  match_context_space_id uuid,
  match_count int default 4,
  rrf_k int default 50
)
returns table (
  id uuid,
  content text,
  source_type text,
  created_at timestamptz,
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
    select s.*
    from public.segments s
    where s.context_space_id = match_context_space_id
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
    c.content,
    c.source_type,
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

revoke all on function public.match_segments(vector, text, uuid, int, int) from public;
grant execute on function public.match_segments(vector, text, uuid, int, int) to authenticated;
