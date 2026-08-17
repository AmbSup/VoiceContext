-- Dialog history remains useful after an empty organizational context is
-- deleted. Keep the session and detach only its former start context.
alter table public.dialog_sessions
  drop constraint dialog_sessions_started_context_id_fkey;

alter table public.dialog_sessions
  add constraint dialog_sessions_started_context_id_fkey
  foreign key (started_context_id)
  references public.contexts (id)
  on delete set null;
