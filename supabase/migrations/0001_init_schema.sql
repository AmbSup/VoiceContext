-- KI Voice Context Engine — initial schema
-- Reflects CONTEXT.md and ADR 0001/0002. MVP is functionally single-user
-- (every context_space has exactly one member, the owner), but the schema
-- is multi-user-ready so sharing can be switched on in V2 without a
-- migration: see ADR 0001.

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ---------------------------------------------------------------------
-- Profiles (mirrors auth.users, one row per Supabase Auth user)
-- ---------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Context Space — shared, invitable ownership container
-- ---------------------------------------------------------------------
create table context_spaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles (id),
  name text not null,
  created_at timestamptz not null default now()
);

-- V2: invite flow populates this beyond the owner row. MVP creates the
-- owner's own membership row on context_space creation and stops there.
create table context_space_members (
  context_space_id uuid not null references context_spaces (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  joined_at timestamptz not null default now(),
  primary key (context_space_id, user_id)
);

-- ---------------------------------------------------------------------
-- Kontext — organizing node inside a Context Space. Forms a loose
-- hierarchy (parent_context_id) but the real "network" property comes
-- from memory_context_links being many-to-many, not from this table.
-- ---------------------------------------------------------------------
create table contexts (
  id uuid primary key default gen_random_uuid(),
  context_space_id uuid not null references context_spaces (id) on delete cascade,
  parent_context_id uuid references contexts (id) on delete set null,
  name text not null,
  description text,
  is_sensitive boolean not null default false, -- prepared, unused in MVP (see CONTEXT.md)
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Dialog Session — one live voice conversation (button start/stop)
-- ---------------------------------------------------------------------
create table dialog_sessions (
  id uuid primary key default gen_random_uuid(),
  context_space_id uuid not null references context_spaces (id) on delete cascade,
  user_id uuid not null references profiles (id),
  started_context_id uuid references contexts (id), -- "aktiver Kontext" at session start
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  full_transcript text
);

-- ---------------------------------------------------------------------
-- Documents — equal-status input path alongside voice (see Q1)
-- ---------------------------------------------------------------------
create table documents (
  id uuid primary key default gen_random_uuid(),
  context_space_id uuid not null references context_spaces (id) on delete cascade,
  uploaded_by uuid not null references profiles (id),
  file_name text not null,
  file_url text not null,
  uploaded_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Segments — output of the Segmentation Engine (always post-hoc, never
-- live — see CONTEXT.md). One of dialog_session_id / document_id is set;
-- 'manual_text' segments have neither.
-- ---------------------------------------------------------------------
create table segments (
  id uuid primary key default gen_random_uuid(),
  context_space_id uuid not null references context_spaces (id) on delete cascade,
  source_type text not null check (source_type in ('voice', 'document', 'manual_text')),
  dialog_session_id uuid references dialog_sessions (id) on delete cascade,
  document_id uuid references documents (id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now(),
  constraint segments_source_matches_type check (
    (source_type = 'voice' and dialog_session_id is not null and document_id is null) or
    (source_type = 'document' and document_id is not null and dialog_session_id is null) or
    (source_type = 'manual_text' and dialog_session_id is null and document_id is null)
  )
);

-- ---------------------------------------------------------------------
-- Memory-Item — smallest unit of knowledge
-- ---------------------------------------------------------------------
create table memory_items (
  id uuid primary key default gen_random_uuid(),
  context_space_id uuid not null references context_spaces (id) on delete cascade,
  segment_id uuid references segments (id) on delete set null,
  type text not null check (type in (
    'fakt', 'entscheidung', 'aufgabe', 'idee', 'annahme', 'offene_frage',
    'ziel', 'risiko', 'person', 'termin', 'ergebnis', 'erkenntnis'
  )),
  content text not null,
  status text not null default 'aktiv' check (status in (
    'aktiv', 'ueberholt', 'historisch', 'unsicher', 'geplant', 'erledigt'
  )),
  superseded_by_id uuid references memory_items (id), -- set by the simple conflict check in Memory Extraction (ADR 0002)
  confidence text check (confidence in ('niedrig', 'mittel', 'hoch')),
  created_by uuid not null references profiles (id),
  visibility text not null default 'oeffentlich' check (visibility in ('privat', 'oeffentlich')), -- prepared, unused in MVP
  approval_status text not null default 'bestaetigt' check (approval_status in ('vorschlag', 'bestaetigt')), -- prepared, unused in MVP
  embedding vector(1536),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index memory_items_embedding_idx on memory_items using hnsw (embedding vector_cosine_ops);
create index memory_items_context_space_idx on memory_items (context_space_id);

-- Many-to-many: a Memory-Item with zero rows here sits in the Inbox.
create table memory_context_links (
  memory_item_id uuid not null references memory_items (id) on delete cascade,
  context_id uuid not null references contexts (id) on delete cascade,
  primary key (memory_item_id, context_id)
);

-- ---------------------------------------------------------------------
-- Entities — MVP resolution is exact match + alias list + confirmed
-- fuzzy suggestions (see CONTEXT.md). Merges are soft and reversible via
-- merged_into_entity_id, never a destructive row merge.
-- ---------------------------------------------------------------------
create table entities (
  id uuid primary key default gen_random_uuid(),
  context_space_id uuid not null references context_spaces (id) on delete cascade,
  name text not null,
  type text not null check (type in ('person', 'organisation', 'produkt', 'sonstiges')),
  merged_into_entity_id uuid references entities (id),
  created_at timestamptz not null default now()
);

create table entity_aliases (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities (id) on delete cascade,
  alias text not null
);

create table entity_merges (
  id uuid primary key default gen_random_uuid(),
  source_entity_id uuid not null references entities (id),
  target_entity_id uuid not null references entities (id),
  merged_by uuid not null references profiles (id),
  merged_at timestamptz not null default now(),
  reverted_at timestamptz
);

create table memory_entity_links (
  memory_item_id uuid not null references memory_items (id) on delete cascade,
  entity_id uuid not null references entities (id) on delete cascade,
  primary key (memory_item_id, entity_id)
);

-- ---------------------------------------------------------------------
-- Row Level Security — scoped by Context Space membership. Written once
-- against context_space_members so V2 (multiple members) needs no policy
-- changes, only new membership rows.
-- ---------------------------------------------------------------------
alter table context_spaces enable row level security;
alter table context_space_members enable row level security;
alter table contexts enable row level security;
alter table dialog_sessions enable row level security;
alter table documents enable row level security;
alter table segments enable row level security;
alter table memory_items enable row level security;
alter table memory_context_links enable row level security;
alter table entities enable row level security;
alter table entity_aliases enable row level security;
alter table entity_merges enable row level security;
alter table memory_entity_links enable row level security;

create policy "member access" on context_spaces for all
  using (id in (select context_space_id from context_space_members where user_id = auth.uid()));

create policy "member access" on context_space_members for all
  using (context_space_id in (select context_space_id from context_space_members where user_id = auth.uid()));

create policy "member access" on contexts for all
  using (context_space_id in (select context_space_id from context_space_members where user_id = auth.uid()));

create policy "member access" on dialog_sessions for all
  using (context_space_id in (select context_space_id from context_space_members where user_id = auth.uid()));

create policy "member access" on documents for all
  using (context_space_id in (select context_space_id from context_space_members where user_id = auth.uid()));

create policy "member access" on segments for all
  using (context_space_id in (select context_space_id from context_space_members where user_id = auth.uid()));

create policy "member access" on memory_items for all
  using (context_space_id in (select context_space_id from context_space_members where user_id = auth.uid()));

create policy "member access" on memory_context_links for all
  using (memory_item_id in (select id from memory_items where context_space_id in (
    select context_space_id from context_space_members where user_id = auth.uid()
  )));

create policy "member access" on entities for all
  using (context_space_id in (select context_space_id from context_space_members where user_id = auth.uid()));

create policy "member access" on entity_aliases for all
  using (entity_id in (select id from entities where context_space_id in (
    select context_space_id from context_space_members where user_id = auth.uid()
  )));

create policy "member access" on entity_merges for all
  using (source_entity_id in (select id from entities where context_space_id in (
    select context_space_id from context_space_members where user_id = auth.uid()
  )));

create policy "member access" on memory_entity_links for all
  using (memory_item_id in (select id from memory_items where context_space_id in (
    select context_space_id from context_space_members where user_id = auth.uid()
  )));
