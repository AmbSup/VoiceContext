-- Raw Realtime API event log per Dialog-Session, for debugging live-dialog
-- issues (VAD-triggered interruptions, token usage growth over a session —
-- see conversation around 2026-08-12 "Ton reisst ab" / "reagiert weniger").
-- Text/JSON only, deliberately NOT audio: the mobile client filters out
-- any event carrying raw audio bytes (response.output_audio.delta and
-- equivalents) before ever sending rows here — see
-- RealtimeDialogController._recordEvent. Storing the actual audio would
-- also revisit the EU-residency concern that made tracing:null a
-- requirement in the first place (see api/realtime-token/route.ts).
--
-- One row per event rather than one JSON blob per session so specific
-- event types (response.cancelled, input_audio_buffer.speech_started,
-- response.done's usage stats) are directly queryable.

create table dialog_session_events (
  id uuid primary key default gen_random_uuid(),
  context_space_id uuid not null references context_spaces (id) on delete cascade,
  dialog_session_id uuid not null references dialog_sessions (id) on delete cascade,
  sequence int not null,
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index dialog_session_events_context_space_id_idx on dialog_session_events (context_space_id);
create index dialog_session_events_dialog_session_id_idx on dialog_session_events (dialog_session_id);
create index dialog_session_events_event_type_idx on dialog_session_events (event_type);

alter table dialog_session_events enable row level security;

create policy "member access" on dialog_session_events for all
  to authenticated
  using (context_space_id in (select private.user_context_space_ids()));
