-- profiles had RLS enabled (0001) but no policy, so no one — not even the
-- owning user — could read or write their own row via the API. A user may
-- only ever see/change their own profile.
create policy "own profile" on profiles for all
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
