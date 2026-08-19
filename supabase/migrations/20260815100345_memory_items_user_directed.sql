-- Ergebnisse screen: distinguishes memory items the user explicitly
-- directed during a conversation (e.g. "merk dir das als offenen Punkt")
-- from ones the extraction pipeline found passively. Populated by the
-- extraction prompt/schema (web/src/lib/pipeline.ts), not by any live
-- Realtime tool — the distinction is inferred post-hoc from the transcript,
-- same deferred-processing philosophy as the rest of the pipeline.
--
-- No backfill: existing rows default to false, the safest reading for rows
-- whose provenance was never captured.

alter table public.memory_items
  add column user_directed boolean not null default false;
