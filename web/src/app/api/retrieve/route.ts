import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createEmbeddings } from "@/lib/openai";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";

// Live-targeted Retrieval for the Realtime dialog's "Antworten" state (see
// docs/implementation-plan.md Phase 2 step 3 / Phase 3). Called by the
// mobile app's RealtimeDialogController when the model invokes the
// retrieve_memory function tool (see the `tools` config in
// api/realtime-token/route.ts — same session that tool is defined for).
//
// Deliberately thin: no LLM answer synthesis here, unlike
// web/src/app/search/actions.ts — the Realtime model itself speaks the
// answer live, grounded on the raw memory items this route returns.
// "Aktiver Kontext" scoping (CONTEXT.md) is intentionally out of scope for
// now — this searches the whole Context Space, same as the web Suche.
//
// Auth follows the same cross-origin Bearer-token pattern as every other
// mobile-facing route (see api/realtime-token/route.ts): the client's own
// Supabase access token both authenticates the request and is forwarded
// via `global.headers` so RLS applies to the .from()/.rpc() calls below —
// auth.getUser(accessToken) alone would only verify the token, not attach
// it to this client's own outgoing requests.

const MATCH_COUNT = 5; // fewer than web Suche's 8 — this rides the live turn-taking latency budget

export async function POST(request: Request) {
  const accessToken = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");

  if (!accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
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
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let query: string | undefined;
  try {
    const body = await request.json();
    query = (body?.query as string | undefined)?.trim();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!query) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);
  const [queryEmbedding] = await createEmbeddings([query], user.id);

  const { data: matches, error: matchError } = await supabase.rpc(
    "match_memory_items",
    {
      query_embedding: queryEmbedding,
      match_context_space_id: contextSpaceId,
      match_count: MATCH_COUNT,
    },
  );

  if (matchError) {
    return NextResponse.json({ error: matchError.message }, { status: 500 });
  }

  return NextResponse.json({ items: matches ?? [] });
}
