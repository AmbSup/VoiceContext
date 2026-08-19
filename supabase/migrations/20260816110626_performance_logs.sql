-- Millisecond-precision timing for backend routes on the live-dialog
-- latency path (see web/src/lib/perf-log.ts) — lets "is X slow" be
-- answered from real numbers instead of a guess. One row per instrumented
-- request; `phases` breaks total_ms down into named sub-durations (e.g.
-- {"embedding": 120, "rpc_candidates": 340, "rerank": 890}).
create table public.performance_logs (
  id uuid primary key default gen_random_uuid(),
  context_space_id uuid references public.context_spaces (id) on delete cascade,
  dialog_session_id uuid references public.dialog_sessions (id) on delete set null,
  route text not null,
  total_ms integer not null check (total_ms >= 0),
  phases jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Primary query shape: recent latencies for one route, e.g. "last 50
-- /api/retrieve calls" for a benchmark comparison.
create index performance_logs_route_created_at_idx
  on public.performance_logs (route, created_at desc);
create index performance_logs_context_space_id_idx
  on public.performance_logs (context_space_id);
create index performance_logs_dialog_session_id_idx
  on public.performance_logs (dialog_session_id);

alter table public.performance_logs enable row level security;

create policy "member access" on public.performance_logs for all
  to authenticated
  using (
    context_space_id is null
    or context_space_id in (select private.user_context_space_ids())
  )
  with check (
    context_space_id is null
    or context_space_id in (select private.user_context_space_ids())
  );

revoke all on table public.performance_logs from anon;
grant select, insert, update, delete on table public.performance_logs to authenticated;
