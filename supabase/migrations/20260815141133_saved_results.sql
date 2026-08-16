-- Durable, user-directed results created during a live voice session.
-- These are deliberately separate from memory_items: an e-mail draft has
-- workflow fields (recipient/status), while memory_items remain the atomic
-- long-term knowledge extracted by the post-processing pipeline.
create table public.saved_results (
  id uuid primary key default gen_random_uuid(),
  context_space_id uuid not null references public.context_spaces (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  dialog_session_id uuid references public.dialog_sessions (id) on delete set null,
  context_id uuid references public.contexts (id) on delete set null,
  kind text not null check (kind in ('email', 'aufgabe', 'frage')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  content text not null check (char_length(btrim(content)) between 1 and 10000),
  recipient text check (recipient is null or char_length(recipient) <= 320),
  due_at timestamptz,
  status text not null check (
    status in ('entwurf', 'offen', 'wartet', 'gesendet', 'erledigt')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Main results screen: newest own results first. The remaining indexes cover
-- foreign-key cleanup/lookups and the two optional screen filters.
create index saved_results_created_by_created_at_idx
  on public.saved_results (created_by, created_at desc);
create index saved_results_context_space_id_idx
  on public.saved_results (context_space_id);
create index saved_results_dialog_session_id_idx
  on public.saved_results (dialog_session_id);
create index saved_results_context_id_idx
  on public.saved_results (context_id);

alter table public.saved_results enable row level security;

create policy "read own saved results"
  on public.saved_results for select
  to authenticated
  using (
    created_by = (select auth.uid())
    and context_space_id in (select private.user_context_space_ids())
  );

create policy "insert own saved results"
  on public.saved_results for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and context_space_id in (select private.user_context_space_ids())
  );

create policy "update own saved results"
  on public.saved_results for update
  to authenticated
  using (
    created_by = (select auth.uid())
    and context_space_id in (select private.user_context_space_ids())
  )
  with check (
    created_by = (select auth.uid())
    and context_space_id in (select private.user_context_space_ids())
  );

create policy "delete own saved results"
  on public.saved_results for delete
  to authenticated
  using (
    created_by = (select auth.uid())
    and context_space_id in (select private.user_context_space_ids())
  );

revoke all on table public.saved_results from anon;
grant select, insert, update, delete on table public.saved_results to authenticated;
