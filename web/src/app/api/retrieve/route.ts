import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  getConfirmedActiveContext,
  resolveContext,
} from "@/lib/active-context";
import { hybridRetrieve } from "@/lib/retrieval";
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
// Without an explicit context_name, retrieval starts in the confirmed active
// context. If that yields nothing, it makes one controlled Context-Space-wide
// fallback. An explicitly named context remains scoped to that single turn.
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
//
// Hybrid Retrieval (embeddings + Postgres full-text search, fused, then
// reranked and thresholded) lives in web/src/lib/retrieval.ts — see
// supabase/migrations/0013_hybrid_retrieval.sql for why. type/context_name/
// occurred_from/occurred_to are optional filters the retrieve_memory tool
// (api/realtime-token/route.ts) can pass when the user's question makes
// them unambiguous (e.g. a named Kontext or an explicit time frame).

const MATCH_COUNT = 5; // fewer than web Suche's 8 — this rides the live turn-taking latency budget
const CONTEXT_MATCH_COUNT = 3;
const RERANK_TIMEOUT_MS = 2500;

// Basic ISO-date validation for occurred_from/occurred_to: an unparseable
// value is dropped (treated as not provided) rather than handed to the RPC,
// and a valid but inverted range (from after to) drops both rather than
// silently returning zero rows for a contradictory filter the model likely
// didn't intend.
function parseOccurredRange(
  from: string | undefined,
  to: string | undefined,
): { from?: string; to?: string } {
  const fromMs = from ? Date.parse(from) : NaN;
  const toMs = to ? Date.parse(to) : NaN;
  const validFrom = from && !Number.isNaN(fromMs) ? from : undefined;
  const validTo = to && !Number.isNaN(toMs) ? to : undefined;
  if (validFrom && validTo && fromMs > toMs) return {};
  return { from: validFrom, to: validTo };
}

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
  let type: string | undefined;
  let contextName: string | undefined;
  let occurredFrom: string | undefined;
  let occurredTo: string | undefined;
  try {
    const body = await request.json();
    query = (body?.query as string | undefined)?.trim();
    type = (body?.type as string | undefined)?.trim() || undefined;
    contextName =
      (body?.context_name as string | undefined)?.trim() || undefined;
    occurredFrom =
      (body?.occurred_from as string | undefined)?.trim() || undefined;
    occurredTo = (body?.occurred_to as string | undefined)?.trim() || undefined;
  } catch {
    return corsJson({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!query) {
    return corsJson({ error: "query is required" }, { status: 400 });
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  let contextId: string | undefined;
  let scopedContextName: string | undefined;
  let isActiveContextScope = false;
  if (contextName) {
    const resolution = await resolveContext(
      supabase,
      contextSpaceId,
      contextName,
    );
    if (resolution.status === "ambiguous") {
      // No retrieval attempt at all here — answering from the wrong
      // Kontext (or an unscoped search) would look plausible but be wrong.
      // The model gets this back as its function_call_output and should
      // ask the user to disambiguate (state "nachfragen").
      return corsJson({
        items: [],
        ambiguous_context: {
          context_name: contextName,
          candidates: resolution.candidates.map(({ name }) => name),
        },
      });
    }
    if (resolution.status === "not_found") {
      return corsJson({
        items: [],
        context_not_found: { context_name: contextName },
      });
    }
    contextId = resolution.context.id;
    scopedContextName = resolution.context.name;
  } else {
    // The confirmed preference is server-owned state. Do not trust a client
    // supplied active_context_id to label an arbitrary context as the user's
    // confirmed default; explicit one-turn focus already uses context_name.
    const activeContext = await getConfirmedActiveContext(
      supabase,
      contextSpaceId,
      user.id,
    );
    if (activeContext) {
      contextId = activeContext.id;
      scopedContextName = activeContext.name;
      isActiveContextScope = true;
    }
  }
  const { from: occurredFromValid, to: occurredToValid } = parseOccurredRange(
    occurredFrom,
    occurredTo,
  );

  try {
    const retrieve = (filterContextId?: string) =>
      hybridRetrieve({
        supabase,
        query,
        contextSpaceId,
        userId: user.id,
        matchCount: MATCH_COUNT,
        contextMatchCount: CONTEXT_MATCH_COUNT,
        filters: {
          types: type ? [type] : undefined,
          contextId: filterContextId,
          occurredFrom: occurredFromValid,
          occurredTo: occurredToValid,
        },
        // Optional, time-boxed: the live voice path is bounded by
        // RetrievalClient's 15s HTTP timeout, so a reranker here must not be
        // allowed to run unbounded on top of the embedding + DB round trips.
        rerank: { mode: "llm", timeoutMs: RERANK_TIMEOUT_MS },
      });
    let items = await retrieve(contextId);
    let fellBackToContextSpace = false;
    if (isActiveContextScope && items.length === 0) {
      items = await retrieve();
      fellBackToContextSpace = true;
    }
    return corsJson({
      items,
      retrieval_scope: {
        mode: contextId
          ? isActiveContextScope
            ? "active_context"
            : "explicit_context"
          : "context_space",
        context_id: contextId,
        context_name: scopedContextName,
        fell_back_to_context_space: fellBackToContextSpace,
      },
    });
  } catch (error) {
    return corsJson(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
