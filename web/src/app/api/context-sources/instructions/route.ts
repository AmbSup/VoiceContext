import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { corsJson, corsPreflight } from "@/lib/cors";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { buildRealtimeInstructions } from "@/lib/realtime-instructions";

// Powers the live mid-session context update: the mobile app can't build
// instructions text itself (GET /api/context-sources deliberately omits
// each source's raw `content`), so when the user toggles sources while a
// Dialog-Session is already active, it calls this route to get freshly
// rendered instructions for the current selection, then sends them over
// the WebRTC data channel as a `session.update`
// (RealtimeDialogController.updateInstructions).

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
    // No/empty body — falls back to defaultEnabledSourceIds below.
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);
  const { instructions } = await buildRealtimeInstructions({
    supabase,
    contextSpaceId,
    userId: user.id,
    enabledSourceIds: requestedSourceIds,
  });

  return corsJson({ instructions });
}
