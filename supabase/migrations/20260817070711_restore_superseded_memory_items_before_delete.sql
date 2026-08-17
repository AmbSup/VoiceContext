-- Deleting a Memory-Item that superseded an older item used to fail because
-- the older row still referenced it through superseded_by_id. Restoring the
-- predecessor before deletion matches rollback_document_import's existing
-- conflict-history semantics and keeps the older fact visible in Retrieval.
create or replace function public.restore_memory_items_before_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.memory_items
  set status = 'aktiv',
      superseded_by_id = null,
      updated_at = now()
  where superseded_by_id = old.id;

  return old;
end;
$$;

revoke all on function public.restore_memory_items_before_delete() from public;

drop trigger if exists restore_memory_items_before_delete
  on public.memory_items;

create trigger restore_memory_items_before_delete
before delete on public.memory_items
for each row
execute function public.restore_memory_items_before_delete();
