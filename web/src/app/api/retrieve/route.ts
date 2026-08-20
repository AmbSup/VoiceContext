import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  getConfirmedActiveContext,
  resolveContext,
} from "@/lib/active-context";
import {
  emptyRetrievalUsage,
  hybridRetrieve,
  type RerankMode,
  type RetrievalResult,
} from "@/lib/retrieval";
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

// Production measurements showed the former 5-second budget being exhausted
// on every recent live request. The reranker now sees a small, source-diverse
// candidate pool and uses the nano model + Fast tier.
const RERANK_TIMEOUT_MS = 3000;

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
  let scope: "active_context" | "context_space" = "active_context";
  try {
    const body = await request.json();
    query = (body?.query as string | undefined)?.trim();
    type = (body?.type as string | undefined)?.trim() || undefined;
    contextName =
      (body?.context_name as string | undefined)?.trim() || undefined;
    occurredFrom =
      (body?.occurred_from as string | undefined)?.trim() || undefined;
    occurredTo = (body?.occurred_to as string | undefined)?.trim() || undefined;
    if (body?.scope === "context_space") scope = "context_space";
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
    // scope: "context_space" is an explicit request from the model for a
    // cross-cutting search (e.g. "In welchen Projekten arbeitet Person A?"
    // — see retrieve_memory's tool description in api/realtime-token/
    // route.ts) — skip context resolution entirely rather than trying a
    // scoped search first, per that feature's spec: immediate, full-space
    // search, no prior local round. contextId stays undefined below, which
    // already makes retrieve() search the whole Context Space directly.
    if (scope === "context_space") {
      // no-op: contextId/scopedContextName/isActiveContextScope stay unset
    } else if (contextName) {
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

    const liveRerank: RerankMode = {
      mode: "llm",
      timeoutMs: RERANK_TIMEOUT_MS,
    };
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
        rerank: liveRerank,
        timer: useTimer,
      });
    // Both attempts always rerank now (see the git history of this file for
    // why the active-context probe used to skip it — that heuristic fired
    // on 65% of real requests, not the rare case it was meant for).
    //
    // The scoped and full-Context-Space searches now run in PARALLEL rather
    // than sequentially-on-demand: a genuine fallback (the active context
    // has nothing relevant) previously meant two full hybridRetrieve passes
    // back to back — embedding + 4 RPCs + rerank, twice — which measured at
    // 7-9s in production. Running both concurrently caps that at roughly
    // the slower of the two instead of their sum. The trade-off is cost,
    // not just latency: every scoped request now always pays for 2x
    // embedding + 2x rerank calls, not only when a fallback turns out to be
    // needed — see /usage if that ratio needs revisiting later.
    //
    // Only the scoped call gets the timer — hybridRetrieve's phase marks
    // (embedding/rpc_candidates/rerank) would interleave nondeterministically
    // between two truly concurrent calls otherwise. total_ms still covers
    // the full parallel wait either way. The "fallback_retrieve" mark now
    // measures how much longer the full-space call took beyond the scoped
    // one (Promise.all's tail), not a second sequential round trip.
    let retrieval: RetrievalResult;
    let fellBackToContextSpace = false;
    if (contextId) {
      const [scoped, full] = await Promise.all([
        retrieve(contextId, timer),
        retrieve(),
      ]);
      timer.mark("fallback_retrieve");
      if (scoped.sources.length > 0) {
        retrieval = scoped;
      } else {
        retrieval = full;
        fellBackToContextSpace = true;
      }
    } else {
      retrieval = await retrieve(undefined, timer);
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
        // Distinguishes "context_space because no active context is set"
        // from "context_space because the model explicitly asked for a
        // cross-cutting search" — both produce mode: "context_space"
        // above, but only the latter has requested_scope set.
        requested_scope: scope,
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
