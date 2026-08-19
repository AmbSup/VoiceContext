-- handle_new_user is only meant to run as the on_auth_user_created trigger
-- (0003/0004). Being SECURITY DEFINER in the public schema, PostgREST
-- otherwise exposes it at /rest/v1/rpc/handle_new_user to anon and
-- authenticated callers by default.
revoke execute on function public.handle_new_user() from anon, authenticated;
