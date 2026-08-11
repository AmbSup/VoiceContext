-- 0005's revoke from anon/authenticated was a no-op: Postgres grants
-- EXECUTE to the PUBLIC pseudo-role by default, and every role (including
-- anon/authenticated) inherits through it. Confirmed via pg_proc.proacl
-- still showing "=X/postgres" (the PUBLIC grant) after 0005. Revoking from
-- PUBLIC itself is what actually removes it from PostgREST's exposed API.
revoke execute on function public.handle_new_user() from public;
