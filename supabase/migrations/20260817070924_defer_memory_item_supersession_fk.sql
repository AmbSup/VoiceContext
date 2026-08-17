-- The statement-level cleanup trigger must run before PostgreSQL validates
-- the self-referencing supersession relation at transaction end.
alter table public.memory_items
  drop constraint memory_items_superseded_by_id_fkey;

alter table public.memory_items
  add constraint memory_items_superseded_by_id_fkey
  foreign key (superseded_by_id)
  references public.memory_items (id)
  deferrable initially deferred;
