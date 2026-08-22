import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { corsJson, corsPreflight } from "@/lib/cors";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { resolveScopedContext } from "@/lib/realtime-instructions";

// Raw context content only — no Role/Personality/Tools/set_dialog_state
// instructions — for clients other than the OpenAI Realtime pipeline that
// still want the user's selected context injected into their own prompt.
// See mobile/lib/features/debug/deepslate/deepslate_test_screen.dart:
// feeding that pipeline's full instructions text (via
// context-sources/instructions/route.ts) to a model with none of its
// tools caused it to narrate dialog-state names like "zuhören"/"nachfragen"
// out loud, since it was told to select one via a tool it doesn't have.

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(request: Request) {
  const accessToken = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    return corsJson({ error: "Not authenticated" }, { status: 401 });
  }

  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } },
  );
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(accessToken);
  if (authError || !user) {
    return corsJson({ error: "Not authenticated" }, { status: 401 });
  }

  let requestedSourceIds: string[] | undefined;
  try {
    const body: unknown = await request.json();
    const ids = (body as { enabledSourceIds?: unknown })?.enabledSourceIds;
    if (Array.isArray(ids)) {
      requestedSourceIds = ids.filter((id): id is string => typeof id === "string");
    }
  } catch {
    // No/empty body — falls back to defaultEnabledSourceIds.
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);
  const { scopedContextBlock, activeContext } = await resolveScopedContext(
    supabase,
    contextSpaceId,
    user.id,
    requestedSourceIds,
  );

  // Same profile fields the OpenAI pipeline already injects (display name +
  // buildAboutMeInstruction, see realtime-token/route.ts) — this endpoint
  // previously omitted them, so the Deepslate screen never knew the user's
  // own name/background at all.
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, age, profession, life_goals, education")
    .eq("id", user.id)
    .maybeSingle();

  // Compact directory of known entities (name + type only — entities carry
  // no facts of their own, see web/src/lib/entities.ts; the facts live in
  // memory_items, reachable via retrieve_memory) so the model recognizes a
  // referenced name/thing as already-known instead of treating it as new.
  // Merged-away entities are excluded — only canonical rows are listed.
  const { data: entityRows } = await supabase
    .from("entities")
    .select("name, type")
    .eq("context_space_id", contextSpaceId)
    .is("merged_into_entity_id", null)
    .order("type")
    .order("name")
    .limit(200);

  return corsJson({
    content: scopedContextBlock,
    activeContextName: activeContext?.name ?? null,
    profile: profile
      ? {
          displayName: profile.display_name?.trim() || null,
          age: profile.age?.trim() || null,
          profession: profile.profession?.trim() || null,
          lifeGoals: profile.life_goals?.trim() || null,
          education: profile.education?.trim() || null,
        }
      : null,
    entities: (entityRows ?? []).map((e) => ({ name: e.name, type: e.type })),
  });
}
