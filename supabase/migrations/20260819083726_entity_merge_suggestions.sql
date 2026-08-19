-- Entity resolution, stage 2 (ADR 0002 / CONTEXT.md "Entity"): fuzzy
-- matching as suggestion-only, plus automatic merge at very high
-- confidence. Stage 1 (web/src/lib/entities.ts, exact name + alias match)
-- already resolves obvious repeats; this covers near-duplicates a plain
-- ilike can't catch (typos, minor spelling variants) without ever letting
-- the model or a low-confidence guess merge two entities on its own.

create extension if not exists pg_trgm;

-- Partial: only canonical (non-merged) entities are ever a fuzzy-match
-- *target* — a merged-away entity's row still exists for history/undo, but
-- new mentions should always resolve towards the current canonical one.
create index entities_name_trgm_idx on entities using gin (name gin_trgm_ops)
  where merged_into_entity_id is null;

-- match_conflict_candidates (0014_conflict_review.sql) is the model for
-- this: same read-only, stable, SQL-language shape, same clamped params.
-- query_entity_id/query_name/query_type are passed in explicitly by the
-- caller (which just created or already has the row) rather than looked
-- up here, mirroring match_conflict_candidates' query_text parameter.
create or replace function public.match_entity_merge_candidates(
  query_entity_id uuid,
  query_name text,
  query_type text,
  match_context_space_id uuid,
  similarity_threshold float8 default 0.4,
  match_count int default 3
)
returns table (id uuid, name text, similarity float8)
language sql
stable
set search_path = 'public'
as $$
  select
    e.id,
    e.name,
    similarity(e.name, left(coalesce(query_name, ''), 200)) as similarity
  from entities e
  where e.context_space_id = match_context_space_id
    and e.type = query_type
    and e.id <> query_entity_id
    and e.merged_into_entity_id is null
    and similarity(e.name, left(coalesce(query_name, ''), 200))
      >= least(greatest(coalesce(similarity_threshold, 0.4), 0), 1)
  order by similarity desc
  limit least(greatest(coalesce(match_count, 3), 1), 20);
$$;

revoke all on function public.match_entity_merge_candidates(uuid, text, text, uuid, float8, int) from public;
grant execute on function public.match_entity_merge_candidates(uuid, text, text, uuid, float8, int) to authenticated;

-- Holds a fuzzy-match verdict pending manual confirmation on /inbox — the
-- suggestion-only path from CONTEXT.md "Entity" ("Fuzzy-Matching schlägt
-- zusätzliche Kandidaten nur als Vorschlag vor"). Automatic merges (very
-- high similarity, see web/src/lib/entities.ts) skip this table entirely
-- and go straight to entity_merges. At most one row per unordered pair,
-- ever — a dismissed suggestion must not resurface on a later pipeline run
-- just because the same near-duplicate name comes up again.
create table entity_merge_suggestions (
  id uuid primary key default gen_random_uuid(),
  context_space_id uuid not null references context_spaces (id) on delete cascade,
  source_entity_id uuid not null references entities (id) on delete cascade,
  target_entity_id uuid not null references entities (id) on delete cascade,
  similarity float8 not null,
  status text not null default 'offen' check (status in ('offen', 'bestaetigt', 'verworfen')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles (id),
  constraint entity_merge_suggestions_distinct_check check (source_entity_id <> target_entity_id)
);

create index entity_merge_suggestions_context_space_idx on entity_merge_suggestions (context_space_id);
create index entity_merge_suggestions_source_idx on entity_merge_suggestions (source_entity_id);
create index entity_merge_suggestions_target_idx on entity_merge_suggestions (target_entity_id);
create index entity_merge_suggestions_resolved_by_idx on entity_merge_suggestions (resolved_by);

create unique index entity_merge_suggestions_pair_idx
  on entity_merge_suggestions (
    (least(source_entity_id, target_entity_id)),
    (greatest(source_entity_id, target_entity_id))
  );

alter table entity_merge_suggestions enable row level security;

create policy "member access" on entity_merge_suggestions for all
  to authenticated
  using (context_space_id in (select private.user_context_space_ids()));

-- Applies (or dismisses) a suggestion in one short transaction, mirroring
-- resolve_memory_conflict (20260814072012_harden_context_conflicts.sql):
-- SECURITY INVOKER, so RLS on entities/entity_merges stays authoritative,
-- and a repeated identical resolution is idempotent while a conflicting
-- second decision is rejected instead of silently overwritten.
create or replace function public.resolve_entity_merge_suggestion(
  p_suggestion_id uuid,
  p_resolution text
)
returns table (result_status text, result_message text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_suggestion public.entity_merge_suggestions%rowtype;
  v_source_merged_into uuid;
  v_target_merged_into uuid;
begin
  if p_resolution not in ('merge', 'keep_separate') then
    return query select 'error'::text, 'Ungültige Auflösung'::text;
    return;
  end if;

  select * into v_suggestion
  from public.entity_merge_suggestions
  where id = p_suggestion_id
  for update;

  if not found then
    return query select 'error'::text, 'Vorschlag nicht gefunden'::text;
    return;
  end if;

  if v_suggestion.status <> 'offen' then
    if (v_suggestion.status = 'bestaetigt' and p_resolution = 'merge')
       or (v_suggestion.status = 'verworfen' and p_resolution = 'keep_separate') then
      return query select 'ok'::text, null::text;
    else
      return query select 'error'::text, 'Vorschlag wurde bereits bearbeitet'::text;
    end if;
    return;
  end if;

  -- Stable lock order prevents two suggestions involving the same pair
  -- from deadlocking each other.
  perform id
  from public.entities
  where id in (v_suggestion.source_entity_id, v_suggestion.target_entity_id)
  order by id
  for update;

  if p_resolution = 'merge' then
    select merged_into_entity_id into v_source_merged_into
    from public.entities where id = v_suggestion.source_entity_id;
    select merged_into_entity_id into v_target_merged_into
    from public.entities where id = v_suggestion.target_entity_id;

    if v_source_merged_into is not null or v_target_merged_into is not null then
      return query select
        'error'::text,
        'Eine der beiden Entitäten wurde inzwischen bereits zusammengeführt.'::text;
      return;
    end if;

    update public.entities
    set merged_into_entity_id = v_suggestion.target_entity_id
    where id = v_suggestion.source_entity_id;

    insert into public.entity_merges (source_entity_id, target_entity_id, merged_by)
    values (v_suggestion.source_entity_id, v_suggestion.target_entity_id, (select auth.uid()));
  end if;

  update public.entity_merge_suggestions
  set status = case when p_resolution = 'merge' then 'bestaetigt' else 'verworfen' end,
      resolved_at = now(),
      resolved_by = (select auth.uid())
  where id = v_suggestion.id;

  return query select 'ok'::text, null::text;
end;
$$;

revoke all on function public.resolve_entity_merge_suggestion(uuid, text) from public;
grant execute on function public.resolve_entity_merge_suggestion(uuid, text) to authenticated;

-- Reversibility for every merge, automatic or manual (ADR 0002: "Jeder
-- Merge (auch automatische) muss rückgängig machbar sein"). A no-op
-- (already reverted) returns 'ok' rather than an error, same idempotency
-- convention as resolve_entity_merge_suggestion above.
create or replace function public.revert_entity_merge(p_merge_id uuid)
returns table (result_status text, result_message text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_merge public.entity_merges%rowtype;
begin
  select * into v_merge
  from public.entity_merges
  where id = p_merge_id
  for update;

  if not found then
    return query select 'error'::text, 'Zusammenführung nicht gefunden'::text;
    return;
  end if;

  if v_merge.reverted_at is not null then
    return query select 'ok'::text, null::text;
    return;
  end if;

  update public.entities
  set merged_into_entity_id = null
  where id = v_merge.source_entity_id
    and merged_into_entity_id = v_merge.target_entity_id;

  update public.entity_merges
  set reverted_at = now()
  where id = v_merge.id;

  return query select 'ok'::text, null::text;
end;
$$;

revoke all on function public.revert_entity_merge(uuid) from public;
grant execute on function public.revert_entity_merge(uuid) to authenticated;
