-- Follow-up hardening after 0015. This timestamp sorts after the migration
-- that creates dismissed_context_pool_items and also upgrades databases where
-- an earlier draft of 0015 may already have run.

grant select, insert, delete
  on table public.dismissed_context_pool_items
  to authenticated;

-- Keep an auditable record of the exact human decision.
alter table public.memory_conflict_reviews
  add column if not exists resolution text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'memory_items_context_space_id_id_key'
      and conrelid = 'public.memory_items'::regclass
  ) then
    alter table public.memory_items
      add constraint memory_items_context_space_id_id_key
      unique (context_space_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'memory_conflict_reviews_distinct_items_check'
      and conrelid = 'public.memory_conflict_reviews'::regclass
  ) then
    alter table public.memory_conflict_reviews
      add constraint memory_conflict_reviews_distinct_items_check
      check (new_memory_item_id <> existing_memory_item_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'memory_conflict_reviews_new_item_space_fkey'
      and conrelid = 'public.memory_conflict_reviews'::regclass
  ) then
    alter table public.memory_conflict_reviews
      add constraint memory_conflict_reviews_new_item_space_fkey
      foreign key (context_space_id, new_memory_item_id)
      references public.memory_items (context_space_id, id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'memory_conflict_reviews_existing_item_space_fkey'
      and conrelid = 'public.memory_conflict_reviews'::regclass
  ) then
    alter table public.memory_conflict_reviews
      add constraint memory_conflict_reviews_existing_item_space_fkey
      foreign key (context_space_id, existing_memory_item_id)
      references public.memory_items (context_space_id, id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'memory_conflict_reviews_resolution_check'
      and conrelid = 'public.memory_conflict_reviews'::regclass
  ) then
    alter table public.memory_conflict_reviews
      add constraint memory_conflict_reviews_resolution_check
      check (
        resolution is null
        or resolution in ('apply_new', 'keep_existing', 'keep_both')
      );
  end if;
end
$$;

-- Resolve the review and both Memory-Items in one short transaction. The
-- function is SECURITY INVOKER, so table grants and RLS stay authoritative.
create or replace function public.resolve_memory_conflict(
  p_review_id uuid,
  p_resolution text
)
returns table (result_status text, result_message text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_review public.memory_conflict_reviews%rowtype;
  v_new_status text;
  v_existing_status text;
begin
  if p_resolution not in ('apply_new', 'keep_existing', 'keep_both') then
    return query select 'error'::text, 'Ungültige Auflösung'::text;
    return;
  end if;

  select *
  into v_review
  from public.memory_conflict_reviews
  where id = p_review_id
  for update;

  if not found then
    return query select 'error'::text, 'Konflikt-Eintrag nicht gefunden'::text;
    return;
  end if;

  -- Repeated delivery of the same form action is harmless; a different
  -- second decision is rejected instead of partially rewriting history.
  if v_review.status <> 'offen' then
    if v_review.resolution = p_resolution then
      return query select 'ok'::text, null::text;
    else
      return query select 'error'::text, 'Konflikt wurde bereits bearbeitet'::text;
    end if;
    return;
  end if;

  -- Stable lock order prevents two reviews involving the same pair from
  -- deadlocking each other.
  perform id
  from public.memory_items
  where id in (v_review.new_memory_item_id, v_review.existing_memory_item_id)
    and context_space_id = v_review.context_space_id
  order by id
  for update;

  select status into v_new_status
  from public.memory_items
  where id = v_review.new_memory_item_id
    and context_space_id = v_review.context_space_id;

  select status into v_existing_status
  from public.memory_items
  where id = v_review.existing_memory_item_id
    and context_space_id = v_review.context_space_id;

  if v_new_status is distinct from 'unsicher'
     or v_existing_status is distinct from 'aktiv' then
    return query select
      'error'::text,
      'Ein Eintrag wurde zwischenzeitlich geändert. Bitte Inbox neu laden.'::text;
    return;
  end if;

  if p_resolution = 'apply_new' then
    update public.memory_items
    set status = 'ueberholt',
        superseded_by_id = v_review.new_memory_item_id
    where id = v_review.existing_memory_item_id
      and context_space_id = v_review.context_space_id;

    update public.memory_items
    set status = 'aktiv', superseded_by_id = null
    where id = v_review.new_memory_item_id
      and context_space_id = v_review.context_space_id;
  elsif p_resolution = 'keep_existing' then
    update public.memory_items
    set status = 'ueberholt',
        superseded_by_id = v_review.existing_memory_item_id
    where id = v_review.new_memory_item_id
      and context_space_id = v_review.context_space_id;
  else
    update public.memory_items
    set status = 'aktiv', superseded_by_id = null
    where id = v_review.new_memory_item_id
      and context_space_id = v_review.context_space_id;
  end if;

  update public.memory_conflict_reviews
  set status = case when p_resolution = 'keep_both' then 'verworfen' else 'bestaetigt' end,
      resolution = p_resolution,
      resolved_at = now(),
      resolved_by = (select auth.uid())
  where id = v_review.id;

  return query select 'ok'::text, null::text;
end;
$$;

revoke all on function public.resolve_memory_conflict(uuid, text) from public;
grant execute on function public.resolve_memory_conflict(uuid, text) to authenticated;

-- Creating the review and hiding the new item from the normal Inbox are one
-- state transition; neither half may commit without the other.
create or replace function public.flag_memory_conflict_review(
  p_context_space_id uuid,
  p_new_memory_item_id uuid,
  p_existing_memory_item_id uuid,
  p_verdict text,
  p_confidence text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_review_id uuid;
  v_locked_count integer;
begin
  if p_new_memory_item_id = p_existing_memory_item_id
     or p_verdict not in ('duplikat', 'widerspruch', 'ersetzt_veraltet')
     or p_confidence not in ('niedrig', 'mittel', 'hoch') then
    raise exception 'Invalid conflict review input'
      using errcode = '22023';
  end if;

  perform id
  from public.memory_items
  where id in (p_new_memory_item_id, p_existing_memory_item_id)
    and context_space_id = p_context_space_id
    and status = 'aktiv'
  order by id
  for update;
  get diagnostics v_locked_count = row_count;

  if v_locked_count <> 2 then
    raise exception 'Conflict items are missing or no longer active'
      using errcode = '40001';
  end if;

  insert into public.memory_conflict_reviews (
    context_space_id,
    new_memory_item_id,
    existing_memory_item_id,
    verdict,
    confidence
  ) values (
    p_context_space_id,
    p_new_memory_item_id,
    p_existing_memory_item_id,
    p_verdict,
    p_confidence
  )
  returning id into v_review_id;

  update public.memory_items
  set status = 'unsicher'
  where id = p_new_memory_item_id
    and context_space_id = p_context_space_id;

  return v_review_id;
end;
$$;

revoke all on function public.flag_memory_conflict_review(uuid, uuid, uuid, text, text) from public;
grant execute on function public.flag_memory_conflict_review(uuid, uuid, uuid, text, text) to authenticated;

-- A multi-chunk document performs external LLM calls between database writes,
-- so it cannot be kept inside one long transaction. If a later chunk fails,
-- this short compensating transaction removes everything created for that
-- document and restores items that those new rows had superseded.
create or replace function public.rollback_document_import(p_document_id uuid)
returns table (storage_path text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_storage_path text;
  v_item_ids uuid[];
begin
  select file_url
  into v_storage_path
  from public.documents
  where id = p_document_id
    and uploaded_by = (select auth.uid())
  for update;

  if not found then
    raise exception 'Document import not found'
      using errcode = 'P0002';
  end if;

  select coalesce(array_agg(m.id), '{}'::uuid[])
  into v_item_ids
  from public.memory_items m
  join public.segments s on s.id = m.segment_id
  where s.document_id = p_document_id;

  update public.memory_items
  set status = 'aktiv', superseded_by_id = null
  where superseded_by_id = any(v_item_ids);

  delete from public.memory_items
  where id = any(v_item_ids);

  delete from public.documents
  where id = p_document_id
    and uploaded_by = (select auth.uid());

  return query select v_storage_path;
end;
$$;

revoke all on function public.rollback_document_import(uuid) from public;
grant execute on function public.rollback_document_import(uuid) to authenticated;
