import type { SupabaseClient } from "@supabase/supabase-js";

// MVP: every user owns exactly one Context Space (see
// supabase/migrations/0004_bootstrap_context_space.sql) — picking between
// several is out of scope until Context-Space-Verwaltung (Phase 5) exists.
export async function getOwnContextSpaceId(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("context_spaces")
    .select("id")
    .eq("owner_id", userId)
    .single();

  if (error) throw error;
  return data.id as string;
}
