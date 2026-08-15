import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { listContextSources } from "@/lib/context-sources";
import { corsJson, corsPreflight } from "@/lib/cors";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";

// Lists every context source (active context, other contexts, linked
// documents, recent sessions) with a token cost, for the mobile app's
// Turn-Kontext-Auswahl screen shown before a Dialog-Session starts. See
// web/src/lib/context-sources.ts.

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: Request) {
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

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);
  const { sources, defaultEnabledSourceIds, tokenBudget } =
    await listContextSources(supabase, contextSpaceId, user.id);

  // `content` is the pre-rendered instruction text realtime-token/route.ts
  // uses server-side to build the Realtime session's system prompt — never
  // meant for the picker UI, so it's stripped before this response goes out.
  return corsJson({
    sources: sources.map(({ content: _content, ...publicFields }) => publicFields),
    defaultEnabledSourceIds,
    tokenBudget,
  });
}
