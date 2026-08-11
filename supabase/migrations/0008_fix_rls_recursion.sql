-- context_space_members' own "member access" policy (0001) subqueries
-- context_space_members itself in its USING clause. Since RLS re-applies to
-- that inner subquery too, this recurses infinitely (Postgres error 42P17,
-- "infinite recursion detected in policy for relation
-- context_space_members"). Every other table's "member access" policy has
-- the same problem one level removed: their subquery reads
-- context_space_members, whose own RLS policy then recurses the same way.
-- Confirmed live: any query against dialog_sessions (or contexts, etc.) as
-- a normal authenticated user JWT fails with 42P17 — this was never
-- exercised end-to-end before (writes so far went through the
-- SECURITY DEFINER handle_new_user trigger, which bypasses RLS).
--
-- Fix (standard Supabase pattern, see security-rls-performance guidance):
-- a SECURITY DEFINER helper function that looks up the caller's
-- context_space_ids while bypassing RLS internally, called from every
-- policy instead of a raw self-referential subquery.
create schema if not exists private;

create or replace function private.user_context_space_ids()
returns setof uuid
language sql
security definer
set search_path = ''
stable
as $$
  select context_space_id
  from public.context_space_members
  where user_id = (select auth.uid());
$$;

revoke execute on function private.user_context_space_ids() from public, anon, authenticated;
grant execute on function private.user_context_space_ids() to authenticated;

drop policy "member access" on context_spaces;
create policy "member access" on context_spaces for all
  to authenticated
  using (id in (select private.user_context_space_ids()));

drop policy "member access" on context_space_members;
create policy "member access" on context_space_members for all
  to authenticated
  using (context_space_id in (select private.user_context_space_ids()));

drop policy "member access" on contexts;
create policy "member access" on contexts for all
  to authenticated
  using (context_space_id in (select private.user_context_space_ids()));

drop policy "member access" on dialog_sessions;
create policy "member access" on dialog_sessions for all
  to authenticated
  using (context_space_id in (select private.user_context_space_ids()));

drop policy "member access" on documents;
create policy "member access" on documents for all
  to authenticated
  using (context_space_id in (select private.user_context_space_ids()));

drop policy "member access" on segments;
create policy "member access" on segments for all
  to authenticated
  using (context_space_id in (select private.user_context_space_ids()));

drop policy "member access" on memory_items;
create policy "member access" on memory_items for all
  to authenticated
  using (context_space_id in (select private.user_context_space_ids()));

drop policy "member access" on memory_context_links;
create policy "member access" on memory_context_links for all
  to authenticated
  using (memory_item_id in (
    select id from memory_items where context_space_id in (select private.user_context_space_ids())
  ));

drop policy "member access" on entities;
create policy "member access" on entities for all
  to authenticated
  using (context_space_id in (select private.user_context_space_ids()));

drop policy "member access" on entity_aliases;
create policy "member access" on entity_aliases for all
  to authenticated
  using (entity_id in (
    select id from entities where context_space_id in (select private.user_context_space_ids())
  ));

drop policy "member access" on entity_merges;
create policy "member access" on entity_merges for all
  to authenticated
  using (source_entity_id in (
    select id from entities where context_space_id in (select private.user_context_space_ids())
  ));

drop policy "member access" on memory_entity_links;
create policy "member access" on memory_entity_links for all
  to authenticated
  using (memory_item_id in (
    select id from memory_items where context_space_id in (select private.user_context_space_ids())
  ));
