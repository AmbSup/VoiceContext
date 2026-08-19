-- "About me" personalization fields (Alter/Beruf/Ziele/Ausbildung), edited in
-- the mobile Profil tab and injected into the Realtime session's system
-- instructions (web/src/lib/realtime-instructions.ts) — same free-text
-- pattern as profiles.display_name (open-ended personal facts, not a fixed
-- set of options like conversation_style, so no CHECK constraint).
--
-- `life_goals` is deliberately not named `goals`: that name is already used
-- by SessionMemoryNote.goals in web/src/lib/short-term-memory.ts, an
-- AI-extracted per-session summary field on `dialog_sessions` — a different
-- table and a different concept (ad-hoc session takeaway, not a persistent
-- profile trait). Keeping the names distinct avoids confusing the two.
alter table profiles
  add column age text,
  add column profession text,
  add column life_goals text,
  add column education text;
