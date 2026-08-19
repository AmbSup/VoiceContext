-- Auth is now wired up (email+password, web + mobile). Every signup in
-- auth.users needs a matching profiles row (profiles.id references
-- auth.users.id), otherwise the "own profile" policy from 0002 has nothing
-- to select — the row must exist before the client can read/write it.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
