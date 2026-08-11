-- Vector similarity search RPC for Retrieval (see
-- docs/implementation-plan.md Phase 3: "Vektorsuche + strukturierte
-- Filter"). Deliberately NOT security definer: it runs with the calling
-- user's own privileges, so the existing "member access" RLS policy on
-- memory_items applies to it exactly like any other query against that
-- table — match_context_space_id is an additional explicit filter, not
-- the only thing keeping results scoped to the caller's own data.
--
-- 'ueberholt' items are excluded because they are, by definition,
-- superseded by a newer memory item (see CONTEXT.md "Status") — surfacing
-- them in Retrieval would resurface stale answers.
--
-- search_path is pinned to 'public' rather than left empty: this function
-- isn't SECURITY DEFINER, so there's no privilege-escalation risk to guard
-- against the way 0008_fix_rls_recursion.sql's helper needs to, but an
-- empty search_path breaks resolution of the pgvector `<=>` operator
-- (registered in `public`, same schema as the extension itself per
-- 0001_init_schema.sql) — and the Supabase linter still flags a fully
-- unset search_path, so pin it instead of omitting it.

create or replace function public.match_memory_items(
  query_embedding vector(1536),
  match_context_space_id uuid,
  match_count int default 8
)
returns table (
  id uuid,
  type text,
  content text,
  status text,
  confidence text,
  occurred_at timestamptz,
  similarity float8
)
language sql
stable
set search_path = 'public'
as $$
  select
    m.id,
    m.type,
    m.content,
    m.status,
    m.confidence,
    m.occurred_at,
    1 - (m.embedding <=> query_embedding) as similarity
  from public.memory_items m
  where m.context_space_id = match_context_space_id
    and m.embedding is not null
    and m.status <> 'ueberholt'
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

revoke all on function public.match_memory_items(vector, uuid, int) from public;
grant execute on function public.match_memory_items(vector, uuid, int) to authenticated;
