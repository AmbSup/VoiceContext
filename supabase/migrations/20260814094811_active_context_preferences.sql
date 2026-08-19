-- Persist only an explicitly confirmed default context. A context used for
-- one retrieval turn remains client/session state and never reaches this
-- table until the user confirms the proposed switch.

alter table public.contexts
  add constraint contexts_context_space_id_id_key
  unique (context_space_id, id);

create table public.active_context_preferences (
  context_space_id uuid not null,
  user_id uuid not null,
  default_context_id uuid not null,
  updated_at timestamptz not null default now(),
  primary key (context_space_id, user_id),
  constraint active_context_preferences_membership_fkey
    foreign key (context_space_id, user_id)
    references public.context_space_members (context_space_id, user_id)
    on delete cascade,
  constraint active_context_preferences_context_fkey
    foreign key (context_space_id, default_context_id)
    references public.contexts (context_space_id, id)
    on delete cascade
);

create index active_context_preferences_default_context_id_idx
  on public.active_context_preferences (default_context_id);

alter table public.active_context_preferences enable row level security;

create policy "users read own active context"
  on public.active_context_preferences for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and context_space_id in (select private.user_context_space_ids())
  );

create policy "users insert own active context"
  on public.active_context_preferences for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and context_space_id in (select private.user_context_space_ids())
  );

create policy "users update own active context"
  on public.active_context_preferences for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and context_space_id in (select private.user_context_space_ids())
  )
  with check (
    user_id = (select auth.uid())
    and context_space_id in (select private.user_context_space_ids())
  );

create policy "users delete own active context"
  on public.active_context_preferences for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    and context_space_id in (select private.user_context_space_ids())
  );

-- New Supabase projects no longer expose new public tables to the Data API
-- automatically. RLS above remains the row-level authorization boundary.
grant select, insert, update, delete
  on table public.active_context_preferences
  to authenticated;
