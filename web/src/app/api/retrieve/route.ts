import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  getConfirmedActiveContext,
  resolveContext,
} from "@/lib/active-context";
import { emptyRetrievalUsage, hybridRetrieve } from "@/lib/retrieval";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { corsJson, corsPreflight } from "@/lib/cors";
import { logPerf, PerfTimer } from "@/lib/perf-log";

// Live-targeted Retrieval for the Realtime dialog's "Antworten" state (see
// docs/implementation-plan.md Phase 2 step 3 / Phase 3). Called by the
// mobile app's RealtimeDialogController when the model invokes the
// retrieve_memory function tool (see the `tools` config in
// api/realtime-token/route.ts — same session that tool is defined for).
//
// Deliberately thin: no LLM answer synthesis here, unlike
// web/src/app/search/actions.ts — the Realtime model itself speaks the
// answer live, grounded on the raw memory items this route returns.
// Retrieval starts scoped — either to the confirmed active context (no
// context_name given) or to the explicitly named one. If that scoped search
// yields nothing, it makes one controlled Context-Space-wide fallback either
// way: the model is instructed to only pass context_name when the user
// explicitly named one, but doesn't always follow that reliably (confirmed
// via a live session where it scoped a person lookup to the wrong context
// after mishearing the name) — an explicit-but-wrong context_name shouldn't
// be able to hide a real match elsewhere any more than the active context
// silently defaulting to the wrong scope should.
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

// Raised from an initial 2500ms after live reproduction: for a real query
// ("Wo wohne ich?") the correct stored fact scored only 0.363 cosine
// similarity — nowhere near a literal-overlap FTS hit — so this path
// depends on reranking actually completing, not falling back. 2500ms was
// tight enough to occasionally lose that race (serverless cold start,
// ordinary network jitter) and silently drop the real answer. The client's
// hard budget is RetrievalClient's 15s HTTP timeout (embedding + 2 RPCs +
// rerank + margin all fit well inside that even at 5000ms).
const RERANK_TIMEOUT_MS = 5000;

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
  const timer = new PerfTimer();
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
  timer.mark("auth");

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
  timer.mark("context_space");

  const { from: occurredFromValid, to: occurredToValid } = parseOccurredRange(
    occurredFrom,
    occurredTo,
  );

  // Everything below — including active-context/context_name resolution —
  // is inside this try block on purpose: a live voice turn is waiting on a
  // function_call_output no matter what fails here, and the model just
  // stalls silently if this route throws past Next.js's default handler
  // instead of returning JSON the client can speak an error from (see
  // RealtimeDialogController._handleRetrieveMemory's catch).
  try {
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
        // Kontext (or an unscoped search) would look plausible but be
        // wrong. The model gets this back as its function_call_output and
        // should ask the user to disambiguate (state "nachfragen").
        await logPerf(supabase, { route: "/api/retrieve", timer, contextSpaceId });
        return corsJson({
          items: [],
          retrieval_usage: emptyRetrievalUsage(),
          ambiguous_context: {
            context_name: contextName,
            candidates: resolution.candidates.map(({ name }) => name),
          },
        });
      }
      if (resolution.status === "not_found") {
        await logPerf(supabase, { route: "/api/retrieve", timer, contextSpaceId });
        return corsJson({
          items: [],
          retrieval_usage: emptyRetrievalUsage(),
          context_not_found: { context_name: contextName },
        });
      }
      contextId = resolution.context.id;
      scopedContextName = resolution.context.name;
    } else {
      // The confirmed preference is server-owned state. Do not trust a
      // client supplied active_context_id to label an arbitrary context as
      // the user's confirmed default; explicit one-turn focus already uses
      // context_name.
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

    const retrieve = (filterContextId?: string, useTimer?: PerfTimer) =>
      hybridRetrieve({
        supabase,
        query,
        contextSpaceId,
        userId: user.id,
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
        timer: useTimer,
      });
    // Timer only passed on the first attempt — hybridRetrieve's phase marks
    // (embedding/rpc_candidates/rerank) would otherwise overwrite themselves
    // on a fallback retry. total_ms still covers both attempts either way.
    let retrieval = await retrieve(contextId, timer);
    let fellBackToContextSpace = false;
    // Falls back for both scope kinds now — an explicit context_name is
    // still tried first (respects a real user-stated focus), but an empty
    // result there no longer dead-ends the turn; see the comment above.
    if (contextId && retrieval.sources.length === 0) {
      retrieval = await retrieve();
      timer.mark("fallback_retrieve");
      fellBackToContextSpace = true;
    }
    await logPerf(supabase, {
      route: "/api/retrieve",
      timer,
      contextSpaceId,
    });
    return corsJson({
      items: retrieval.sources,
      retrieval_usage: retrieval.usage,
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
    await logPerf(supabase, { route: "/api/retrieve", timer, contextSpaceId });
    return corsJson(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
