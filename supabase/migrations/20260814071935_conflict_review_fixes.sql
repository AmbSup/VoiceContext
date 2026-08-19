-- Fixes from today's code review of the Hybrid Retrieval / Extraktions-
-- pipeline / Aktiver-Kontext work (0013-0014 and
-- 20260814120000_active_context_preferences.sql).

-- P1: memory_conflict_reviews (0014) never got the explicit Data-API grant that
-- active_context_preferences correctly has — newer Supabase projects don't
-- expose new public tables to the Data API automatically anymore, so
-- authenticated clients could hit "permission denied" on Inbox queries
-- depending on the project's Data-API-exposure setting. RLS remains the
-- actual row-level boundary; this is what makes the tables reachable at
-- all.
grant select, insert, update, delete
  on table public.memory_conflict_reviews
  to authenticated;

-- dismissed_context_pool_items is created by the later timestamped migration
-- 20260813135514, so its grant belongs in a migration after that one. Keeping
-- it here would make a clean `db reset` fail before the table exists.

-- P2: the classifier in web/src/lib/pipeline.ts is meant to produce at most
-- one *open* review per new item (see 0014's comment), but nothing
-- previously enforced that — a duplicated/hallucinated verdict pair could
-- insert two open reviews for the same new_memory_item_id. Enforced here
-- rather than only in application code, since the app-side dedupe added
-- alongside this migration can't protect against concurrent pipeline runs.
create unique index memory_conflict_reviews_new_item_open_idx
  on memory_conflict_reviews (new_memory_item_id)
  where status = 'offen';

-- P1: "Bestätigen" in web/src/app/inbox/actions.ts did three independent,
-- unlocked updates (supersede existing -> flip new back to aktiv -> close
-- review). A failure between steps left an inconsistent state, and nothing
-- stopped a double-click or two concurrent requests from both succeeding
-- against the same review. Replaced with one row-locked, status-checked
-- RPC. security invoker (not definer): runs with the caller's own
-- privileges, so the existing "member access" RLS on memory_items and
-- memory_conflict_reviews still applies — a review the caller can't see
-- via RLS is invisible to `select ... for update` too, giving the same
-- "not found" result as an ownership check would.
--
-- P2: a genuine "widerspruch" means a human has to decide which side is
-- current, not that the new item automatically wins — the old
-- confirm/dismiss pair only ever superseded the existing item. Three
-- resolutions now: apply_new (existing -> ueberholt, same as before),
-- keep_existing (new -> ueberholt, superseded by the existing one — the
-- new item was the wrong/outdated statement), keep_both (neither
-- superseded — the classifier's guessed relation wasn't real).
create or replace function public.resolve_memory_conflict(
  p_review_id uuid,
  p_resolution text
)
returns table (result_status text, result_message text)
language plpgsql
security invoker
set search_path = 'public'
as $$
declare
  v_review record;
begin
  if p_resolution not in ('apply_new', 'keep_existing', 'keep_both') then
    return query select 'error'::text, 'Ungültige Auflösung'::text;
    return;
  end if;

  select * into v_review
  from memory_conflict_reviews
  where id = p_review_id
  for update;

  if not found then
    return query select 'error'::text, 'Konflikt-Eintrag nicht gefunden'::text;
    return;
  end if;
  if v_review.status <> 'offen' then
    return query select 'error'::text, 'Konflikt wurde bereits bearbeitet'::text;
    return;
  end if;

  if p_resolution = 'apply_new' then
    update memory_items
      set status = 'ueberholt', superseded_by_id = v_review.new_memory_item_id
      where id = v_review.existing_memory_item_id and status = 'aktiv';
    update memory_items
      set status = 'aktiv'
      where id = v_review.new_memory_item_id and status = 'unsicher';
  elsif p_resolution = 'keep_existing' then
    update memory_items
      set status = 'ueberholt', superseded_by_id = v_review.existing_memory_item_id
      where id = v_review.new_memory_item_id and status = 'unsicher';
  else
    update memory_items
      set status = 'aktiv'
      where id = v_review.new_memory_item_id and status = 'unsicher';
  end if;

  update memory_conflict_reviews
    set
      status = case when p_resolution = 'keep_both' then 'verworfen' else 'bestaetigt' end,
      resolved_at = now(),
      resolved_by = (select auth.uid())
    where id = p_review_id;

  return query select 'ok'::text, null::text;
end;
$$;

revoke all on function public.resolve_memory_conflict(uuid, text) from public;
grant execute on function public.resolve_memory_conflict(uuid, text) to authenticated;

-- P2: match_contexts (0013) always ranked against every context in the
-- space and only got scoped to a specific context_id afterwards, in
-- application code (web/src/lib/retrieval.ts). If the active/explicit
-- context wasn't among the global top contextMatchCount matches, its own
-- description silently disappeared from the result instead of being
-- guaranteed present — the opposite of what a context_id filter should do.
-- Mirrors match_memory_items' match_context_id parameter, filtered inside
-- the candidates CTE (before ranking/limit) rather than after. Dropped and
-- recreated rather than `create or replace`: adding a trailing parameter
-- to an existing function creates a second overload instead of replacing
-- it, which would make named-parameter RPC calls that omit
-- match_context_id ambiguous between the two signatures.
drop function if exists public.match_contexts(vector, text, uuid, int, int);

create or replace function public.match_contexts(
  query_embedding vector(1536),
  query_text text,
  match_context_space_id uuid,
  match_count int default 5,
  rrf_k int default 50,
  match_context_id uuid default null
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
      and (match_context_id is null or c.id = match_context_id)
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

revoke all on function public.match_contexts(vector, text, uuid, int, int, uuid) from public;
grant execute on function public.match_contexts(vector, text, uuid, int, int, uuid) to authenticated;
