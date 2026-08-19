-- Conversation-style preference (rule #7 from the GPT-Live-inspired
-- conversation-control rules, adapted for gpt-realtime-2.1): the user picks
-- one of three fixed personas in the Profil tab; the chosen style is
-- injected into the Realtime session's system instructions
-- (web/src/lib/realtime-instructions.ts), changing tone and how often the
-- model asks follow-up questions. 'neutral' is the existing default
-- persona — every existing row keeps behaving exactly as before.
alter table profiles
  add column conversation_style text not null default 'neutral'
    check (conversation_style in ('neutral', 'coach', 'denkpartner'));
