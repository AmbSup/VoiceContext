-- Manual merge trigger for the /entities detail page (as opposed to
-- resolve_entity_merge_suggestion, which only applies a pre-existing
-- fuzzy-match suggestion). Same underlying effect — a soft, reversible
-- merged_into_entity_id pointer plus an entity_merges audit row — just
-- without requiring a suggestion row to exist first, for the case where
-- the user spots a duplicate the fuzzy matcher never flagged.
create or replace function public.merge_entities(
  p_source_entity_id uuid,
  p_target_entity_id uuid
)
returns table (result_status text, result_message text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source_space uuid;
  v_target_space uuid;
  v_source_merged_into uuid;
  v_target_merged_into uuid;
begin
  if p_source_entity_id = p_target_entity_id then
    return query select 'error'::text, 'Eine Entität kann nicht mit sich selbst zusammengeführt werden.'::text;
    return;
  end if;

  -- Stable lock order prevents two concurrent merges of the same pair
  -- from deadlocking each other (same pattern as resolve_entity_merge_
  -- suggestion in 20260818090000_entity_merge_suggestions.sql).
  perform id
  from public.entities
  where id in (p_source_entity_id, p_target_entity_id)
  order by id
  for update;

  select context_space_id, merged_into_entity_id
    into v_source_space, v_source_merged_into
    from public.entities where id = p_source_entity_id;
  select context_space_id, merged_into_entity_id
    into v_target_space, v_target_merged_into
    from public.entities where id = p_target_entity_id;

  if v_source_space is null or v_target_space is null then
    return query select 'error'::text, 'Entität nicht gefunden'::text;
    return;
  end if;

  if v_source_space <> v_target_space then
    return query select 'error'::text, 'Die Entitäten gehören zu unterschiedlichen Context Spaces.'::text;
    return;
  end if;

  if v_source_merged_into is not null or v_target_merged_into is not null then
    return query select 'error'::text, 'Eine der beiden Entitäten wurde bereits zusammengeführt.'::text;
    return;
  end if;

  update public.entities
  set merged_into_entity_id = p_target_entity_id
  where id = p_source_entity_id;

  insert into public.entity_merges (source_entity_id, target_entity_id, merged_by)
  values (p_source_entity_id, p_target_entity_id, (select auth.uid()));

  return query select 'ok'::text, null::text;
end;
$$;

revoke all on function public.merge_entities(uuid, uuid) from public;
grant execute on function public.merge_entities(uuid, uuid) to authenticated;
