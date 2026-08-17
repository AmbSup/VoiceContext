-- A row-level BEFORE DELETE trigger can update another row that is also
-- scheduled for deletion by the same bulk statement, causing PostgreSQL's
-- "tuple already modified" error. Process the complete deleted set once.
drop trigger if exists restore_memory_items_before_delete
  on public.memory_items;

drop function if exists public.restore_memory_items_before_delete();

create or replace function public.restore_memory_items_after_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.memory_items as m
  set status = 'aktiv',
      superseded_by_id = null,
      updated_at = now()
  where m.superseded_by_id in (
    select deleted.id
    from deleted_memory_items as deleted
  );

  return null;
end;
$$;

revoke all on function public.restore_memory_items_after_delete() from public;

drop trigger if exists restore_memory_items_after_delete
  on public.memory_items;

create trigger restore_memory_items_after_delete
after delete on public.memory_items
referencing old table as deleted_memory_items
for each statement
execute function public.restore_memory_items_after_delete();
