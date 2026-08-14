import type { SupabaseClient } from "@supabase/supabase-js";

export type ActiveContext = { id: string; name: string };

export type ContextResolution =
  | { status: "resolved"; context: ActiveContext }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: ActiveContext[] };

const AMBIGUOUS_CANDIDATE_LIMIT = 5;

export async function resolveContext(
  supabase: SupabaseClient,
  contextSpaceId: string,
  contextName: string,
): Promise<ContextResolution> {
  const name = contextName.trim().slice(0, 200);
  if (!name) return { status: "not_found" };

  const { data: exactMatches, error: exactError } = await supabase
    .from("contexts")
    .select("id, name")
    .eq("context_space_id", contextSpaceId)
    .ilike("name", name)
    .limit(AMBIGUOUS_CANDIDATE_LIMIT);
  if (exactError) throw exactError;
  const exact = exactMatches ?? [];
  if (exact.length === 1) {
    return { status: "resolved", context: exact[0] as ActiveContext };
  }
  if (exact.length > 1) {
    return {
      status: "ambiguous",
      candidates: exact as ActiveContext[],
    };
  }

  const escapedName = name.replace(/[\\%_]/g, "\\$&");
  const { data: partialMatches, error: partialError } = await supabase
    .from("contexts")
    .select("id, name")
    .eq("context_space_id", contextSpaceId)
    .ilike("name", `%${escapedName}%`)
    .limit(AMBIGUOUS_CANDIDATE_LIMIT);
  if (partialError) throw partialError;
  const partial = partialMatches ?? [];
  if (partial.length === 1) {
    return { status: "resolved", context: partial[0] as ActiveContext };
  }
  if (partial.length > 1) {
    return {
      status: "ambiguous",
      candidates: partial as ActiveContext[],
    };
  }
  return { status: "not_found" };
}

export async function getConfirmedActiveContext(
  supabase: SupabaseClient,
  contextSpaceId: string,
  userId: string,
): Promise<ActiveContext | null> {
  const { data: preference, error: preferenceError } = await supabase
    .from("active_context_preferences")
    .select("default_context_id")
    .eq("context_space_id", contextSpaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (preferenceError) throw preferenceError;
  if (!preference) return null;

  const { data: context, error: contextError } = await supabase
    .from("contexts")
    .select("id, name")
    .eq("context_space_id", contextSpaceId)
    .eq("id", preference.default_context_id)
    .maybeSingle();
  if (contextError) throw contextError;
  return (context as ActiveContext | null) ?? null;
}
