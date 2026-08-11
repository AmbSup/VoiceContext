-- Tracks the post-hoc Segmentation/Memory-Extraction/Context-Classification
-- pipeline state per Dialog-Session (docs/implementation-plan.md Phase 2,
-- steps 4-6). Also the idempotency guard for
-- web/src/app/api/dialog-sessions/[id]/process: 'fertig' short-circuits a
-- repeat call, 'laeuft' rejects a concurrent one, 'fehlgeschlagen' allows
-- retry.
alter table dialog_sessions
  add column processing_status text not null default 'unbearbeitet'
    check (processing_status in ('unbearbeitet', 'laeuft', 'fertig', 'fehlgeschlagen')),
  add column processing_error text,
  add column processed_at timestamptz;
