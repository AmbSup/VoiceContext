import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  getConfirmedActiveContext,
  resolveContext,
} from "@/lib/active-context";
import { corsJson, corsPreflight } from "@/lib/cors";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";

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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return corsJson({ error: "Invalid JSON body" }, { status: 400 });
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);
  const action = body.action;

  if (action === "get") {
    const activeContext = await getConfirmedActiveContext(
      supabase,
      contextSpaceId,
      user.id,
    );
    return corsJson({ active_context: activeContext });
  }

  if (action === "resolve") {
    const contextName =
      typeof body.context_name === "string" ? body.context_name : "";
    const resolution = await resolveContext(
      supabase,
      contextSpaceId,
      contextName,
    );
    if (resolution.status === "ambiguous") {
      return corsJson({
        status: "ambiguous",
        candidates: resolution.candidates.map(({ name }) => name),
      });
    }
    return corsJson(resolution);
  }

  if (action === "confirm") {
    const contextId =
      typeof body.context_id === "string" ? body.context_id : "";
    const { data: context, error: contextError } = await supabase
      .from("contexts")
      .select("id, name")
      .eq("context_space_id", contextSpaceId)
      .eq("id", contextId)
      .maybeSingle();
    if (contextError) throw contextError;
    if (!context) {
      return corsJson({ error: "Context not found" }, { status: 404 });
    }

    const { error: upsertError } = await supabase
      .from("active_context_preferences")
      .upsert(
        {
          context_space_id: contextSpaceId,
          user_id: user.id,
          default_context_id: context.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "context_space_id,user_id" },
      );
    if (upsertError) throw upsertError;
    return corsJson({ active_context: context });
  }

  // Deselects the default context entirely — active_context_preferences has
  // no nullable/sentinel "no default" value (default_context_id is NOT
  // NULL), so "no default" is represented purely by the row's absence,
  // same as before any preference was ever set. getConfirmedActiveContext
  // already treats "no row" as no active context (see its "kein
  // Standardkontext bestätigt" branch in realtime-instructions.ts).
  if (action === "clear") {
    const { error: deleteError } = await supabase
      .from("active_context_preferences")
      .delete()
      .eq("context_space_id", contextSpaceId)
      .eq("user_id", user.id);
    if (deleteError) throw deleteError;
    return corsJson({ active_context: null });
  }

  return corsJson({ error: "Unsupported action" }, { status: 400 });
}
