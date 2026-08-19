-- MVP bootstrap: every user gets exactly one Context Space of their own on
-- signup (see CONTEXT.md "Context Space" MVP note: "jede Context Space
-- genau ein Mitglied, den Owner"). Phase 5's Context-Space-Verwaltung UI
-- to create/manage further ones doesn't exist yet, so without this nothing
-- with a context_space_id FK (Dialog-Session included) has anywhere to
-- attach to right after signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_context_space_id uuid;
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');

  insert into public.context_spaces (owner_id, name)
  values (new.id, 'Meine Context Space')
  returning id into new_context_space_id;

  insert into public.context_space_members (context_space_id, user_id, role)
  values (new_context_space_id, new.id, 'owner');

  return new;
end;
$$;
