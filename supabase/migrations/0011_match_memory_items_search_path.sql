-- match_memory_items() (0010) was missing an explicit search_path, which
-- the Supabase security linter flags even for non-SECURITY DEFINER
-- functions (a caller-controlled search_path could still shadow
-- unqualified references). Every reference inside the function body is
-- already schema-qualified (public.memory_items, and the pgvector `<=>`
-- operator lives in public alongside the extension per 0001_init_schema.sql
-- comments), so pinning to 'public' (not '' like the SECURITY DEFINER
-- helper in 0008) closes the lint without breaking operator resolution.
alter function public.match_memory_items(vector, uuid, int)
  set search_path to 'public';
