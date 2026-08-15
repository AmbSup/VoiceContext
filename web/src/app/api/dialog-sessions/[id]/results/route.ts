import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { corsJson, corsPreflight } from "@/lib/cors";

// Ergebnisse screen: returns the memory items a finished Dialog-Session
// produced, distinguishing user-directed ones (see pipeline.ts's
// user_directed field) from passively-extracted ones. Same auth pattern as
// dialog-sessions/[id]/process/route.ts — anon-key client with the caller's
// own token, so RLS enforces context_space membership.

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const { id: dialogSessionId } = await params;

  const { data: session } = await supabase
    .from("dialog_sessions")
    .select("id, processing_status")
    .eq("id", dialogSessionId)
    .single();

  // RLS already scopes this to rows the caller's context_space membership
  // covers, so a missing row means "not found or not yours" — either way
  // there's nothing more to say than 404.
  if (!session) {
    return corsJson({ error: "Dialog session not found" }, { status: 404 });
  }
  if (session.processing_status !== "fertig") {
    return corsJson(
      {
        error: "Dialog session is not yet processed",
        status: session.processing_status,
      },
      { status: 409 },
    );
  }

  const { data: segmentRows, error: segmentsError } = await supabase
    .from("segments")
    .select("id")
    .eq("dialog_session_id", dialogSessionId);
  if (segmentsError) throw segmentsError;
  const segmentIds = (segmentRows ?? []).map((s) => s.id as string);

  const { data: itemRows, error: itemsError } = segmentIds.length
    ? await supabase
        .from("memory_items")
        .select("id, type, content, status, confidence, user_directed, created_at")
        .in("segment_id", segmentIds)
        .order("user_directed", { ascending: false })
        .order("created_at", { ascending: true })
    : { data: [], error: null };
  if (itemsError) throw itemsError;

  return corsJson({
    status: "fertig",
    items: (itemRows ?? []).map((item) => ({
      id: item.id,
      type: item.type,
      content: item.content,
      status: item.status,
      confidence: item.confidence,
      userDirected: item.user_directed,
      createdAt: item.created_at,
    })),
  });
}
