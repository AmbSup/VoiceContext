-- Kontext-Name/-Beschreibung become part of Retrieval, alongside
-- memory_items (see match_memory_items in 0010_match_memory_items.sql).
-- Until now, a fact typed only into a Kontext's Beschreibung (rather than
-- captured as an actual Memory-Item via voice/text/document) was
-- invisible to Suche/live retrieve_memory — CONTEXT.md is explicit that a
-- Kontext is "nur" an organizing node, not a knowledge container, but in
-- practice users type real facts into the description field anyway, so
-- Retrieval needs to cover it too rather than silently finding nothing.

alter table contexts add column embedding vector(1536);

create index contexts_embedding_idx on contexts using hnsw (embedding vector_cosine_ops);

create or replace function public.match_contexts(
  query_embedding vector(1536),
  match_context_space_id uuid,
  match_count int default 5
)
returns table (
  id uuid,
  name text,
  description text,
  similarity float8
)
language sql
stable
set search_path = 'public'
as $$
  select
    c.id,
    c.name,
    c.description,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.contexts c
  where c.context_space_id = match_context_space_id
    and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

revoke all on function public.match_contexts(vector, uuid, int) from public;
grant execute on function public.match_contexts(vector, uuid, int) to authenticated;
