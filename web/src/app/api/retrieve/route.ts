import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createEmbeddings } from "@/lib/openai";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { corsJson, corsPreflight } from "@/lib/cors";

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
// Also searches Kontext name/description (match_contexts, see
// supabase/migrations/0011_context_embeddings.sql): CONTEXT.md treats a
// Kontext as "nur" an organizing node, not a knowledge container, but in
// practice a fact typed only into a Beschreibung (never captured as an
// actual Memory-Item) was otherwise invisible to Retrieval — confirmed by
// a user hitting exactly that wall.
//
// Auth follows the same cross-origin Bearer-token pattern as every other
// mobile-facing route (see api/realtime-token/route.ts): the client's own
// Supabase access token both authenticates the request and is forwarded
// via `global.headers` so RLS applies to the .from()/.rpc() calls below —
// auth.getUser(accessToken) alone would only verify the token, not attach
// it to this client's own outgoing requests.

const MATCH_COUNT = 5; // fewer than web Suche's 8 — this rides the live turn-taking latency budget
const CONTEXT_MATCH_COUNT = 3;

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

  let query: string | undefined;
  try {
    const body = await request.json();
    query = (body?.query as string | undefined)?.trim();
  } catch {
    return corsJson({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!query) {
    return corsJson({ error: "query is required" }, { status: 400 });
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);
  const [queryEmbedding] = await createEmbeddings([query], user.id);

  const [memoryItemsResult, contextsResult] = await Promise.all([
    supabase.rpc("match_memory_items", {
      query_embedding: queryEmbedding,
      match_context_space_id: contextSpaceId,
      match_count: MATCH_COUNT,
    }),
    supabase.rpc("match_contexts", {
      query_embedding: queryEmbedding,
      match_context_space_id: contextSpaceId,
      match_count: CONTEXT_MATCH_COUNT,
    }),
  ]);

  if (memoryItemsResult.error) {
    return corsJson({ error: memoryItemsResult.error.message }, { status: 500 });
  }
  if (contextsResult.error) {
    return corsJson({ error: contextsResult.error.message }, { status: 500 });
  }

  const contextItems = (contextsResult.data ?? []).map(
    (context: { id: string; name: string; description: string | null }) => ({
      id: context.id,
      type: "kontext_beschreibung",
      content: context.description
        ? `${context.name}: ${context.description}`
        : context.name,
    }),
  );

  // TEMP diagnostic (remove once the "keine Infos gespeichert" reports are
  // root-caused): the live model claims empty results for queries that
  // rank real facts in the top 5 when tested via direct DB access — that
  // test bypasses RLS though, so this logs what the actual RLS-scoped
  // route call sees.
  console.log("[retrieve] diag", {
    query,
    contextSpaceId,
    memoryItemCount: memoryItemsResult.data?.length ?? 0,
    contextItemCount: contextItems.length,
    topMemoryItems: (memoryItemsResult.data ?? []).slice(0, 3).map(
      (m: { content: string; similarity: number }) => ({ content: m.content, similarity: m.similarity }),
    ),
  });

  return corsJson({ items: [...(memoryItemsResult.data ?? []), ...contextItems] });
}
