import type { SupabaseClient } from "@supabase/supabase-js";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import { createChatCompletion, createEmbeddings } from "@/lib/openai";

// Hybrid Retrieval — shared by web/src/app/search/actions.ts (web Suche) and
// web/src/app/api/retrieve/route.ts (mobile's live retrieve_memory tool).
// Centralizes what used to be duplicated pure-vector calls to
// match_memory_items/match_contexts. See supabase/migrations/
// 0013_hybrid_retrieval.sql for the DB-side RRF fusion of embedding
// similarity and Postgres full-text search — that migration's comment has
// the full rationale (names/exact phrases/dates are unreliable via
// embeddings alone).
//
// Pipeline: query -> best-effort embedding -> hybrid RPCs (FTS + vector,
// metadata filters applied inside the RPC before ranking) -> RRF-fused
// candidate pool -> optional LLM reranking -> conservative relevance gate
// (always, regardless of reranking) -> one shared token budget across both
// source kinds. The RPC limits only bound work; they no longer decide how
// many sources reach the answer.
//
// Reranking is NOT mandatory: it's a real network round trip on top of the
// embedding call and two DB queries, and the live voice path
// (api/retrieve/route.ts) is bounded by RetrievalClient's 15s HTTP timeout
// (mobile/lib/core/api/retrieval_client.dart) — stacking an unbounded LLM
// call on that budget is too risky. Callers choose a `rerank` mode:
// "off" (voice default: RRF ordering only), or "llm" with an optional
// `timeoutMs` (voice can opt into a time-boxed reranker; web Suche uses
// "llm" with no timeout, since it isn't on a hard latency budget).
//
// Whatever ranking method produced the list, every candidate must still
// clear a conservative relevance gate before going out: a real FTS hit
// (fts_rank > 0) or a similarity at/above CONSERVATIVE_VECTOR_THRESHOLD.
// This is deliberately independent of the LLM's relevance_score — an LLM
// rerank score is not itself evidence the candidate is actually grounded in
// the query, so a candidate with no lexical or vector grounding is dropped
// even if reranking scored it above DEFAULT_MIN_RELEVANCE.

const RERANK_MODEL = "gpt-4.1-mini"; // same model already used for Suche's Answer Engine
// Experimental starting values, not yet calibrated against real data — see
// the roadmap's later "Retrieval-Evaluation" step (30-50 real queries,
// Precision@5/Recall@5/no-result accuracy). Revisit both once that exists.
const DEFAULT_MIN_RELEVANCE = 0.35;
// Lowered from an initial 0.75 after live production evidence: a genuinely
// correct, stored fact ("Martin Amon lebt in Wiener Neustadt...") failed
// this floor against the paraphrased query "Wohnort des Nutzers" (zero
// lexical overlap for `simple`-config FTS, and text-embedding-3-small's
// cosine similarity for true-but-differently-worded matches routinely lands
// well under 0.75 — 0.75 is close to near-duplicate wording, not "related").
// 0.45 still blocks unrelated candidates (typically <0.2 similarity) while
// no longer vetoing real matches.
const CONSERVATIVE_VECTOR_THRESHOLD = 0.45;
const DEFAULT_MEMORY_CANDIDATE_COUNT = 30;
const DEFAULT_CONTEXT_CANDIDATE_COUNT = 10;
export const DEFAULT_RETRIEVAL_TOKEN_BUDGET = 2500;
const MAX_QUERY_LENGTH = 500;
const retrievalEncoding = new Tiktoken(o200kBase);

export type RerankMode = { mode: "off" } | { mode: "llm"; timeoutMs?: number };

export interface RetrievalFilters {
  types?: string[];
  contextId?: string;
  occurredFrom?: string;
  occurredTo?: string;
}

export interface RetrievedMemoryItem {
  kind: "memory_item";
  id: string;
  type: string;
  content: string;
  status: string;
  confidence: string | null;
  occurred_at: string;
  similarity: number;
  fts_rank: number;
  relevance_score: number;
}

export interface RetrievedContext {
  kind: "context";
  id: string;
  name: string;
  description: string | null;
  similarity: number;
  fts_rank: number;
  relevance_score: number;
}

export type RetrievedSource = RetrievedMemoryItem | RetrievedContext;

export interface RetrievalUsage {
  usedTokens: number;
  maxTokens: number;
  candidateCount: number;
  selectedCount: number;
  truncated: boolean;
}

export interface RetrievalResult {
  sources: RetrievedSource[];
  usage: RetrievalUsage;
}

export function emptyRetrievalUsage(
  maxTokens = DEFAULT_RETRIEVAL_TOKEN_BUDGET,
): RetrievalUsage {
  return {
    usedTokens: 0,
    maxTokens,
    candidateCount: 0,
    selectedCount: 0,
    truncated: false,
  };
}

interface MemoryItemCandidateRow {
  id: string;
  type: string;
  content: string;
  status: string;
  confidence: string | null;
  occurred_at: string;
  similarity: number;
  fts_rank: number;
  fused_score: number;
}

interface ContextCandidateRow {
  id: string;
  name: string;
  description: string | null;
  similarity: number;
  fts_rank: number;
  fused_score: number;
}

type Candidate =
  | (MemoryItemCandidateRow & { kind: "memory_item" })
  | (ContextCandidateRow & { kind: "context" });

function buildRerankSystemPrompt(): string {
  return `Du bewertest für eine Retrieval-Pipeline, wie relevant gefundene Kandidaten (Memory-Items und Kontext-Beschreibungen aus dem persönlichen Wissen eines Nutzers) für eine Suchanfrage inhaltlich wirklich sind — nicht nur oberflächlich ähnlich, sondern ob der Inhalt tatsächlich zur Beantwortung beiträgt.

Vergib für JEDEN Kandidaten (per id, jede id aus der Liste genau einmal) einen relevance_score zwischen 0 und 1:
- 1.0: beantwortet die Anfrage direkt oder ist eindeutig relevanter Kontext dafür.
- ~0.5: thematisch verwandt, aber nicht direkt hilfreich.
- 0.0: kein inhaltlicher Zusammenhang zur Anfrage, auch wenn Wörter überlappen.`;
}

function buildRerankUserPrompt(query: string, candidates: Candidate[]): string {
  const items = candidates.map((c) =>
    c.kind === "memory_item"
      ? {
          id: c.id,
          kind: c.kind,
          type: c.type,
          content: c.content,
          occurred_at: c.occurred_at,
        }
      : {
          id: c.id,
          kind: c.kind,
          content: c.description ? `${c.name}: ${c.description}` : c.name,
        },
  );
  return `## Anfrage\n${query}\n\n## Kandidaten\n${JSON.stringify(items)}`;
}

async function rerankCandidates(
  query: string,
  candidates: Candidate[],
  userId: string,
  timeoutMs?: number,
): Promise<Map<string, number>> {
  // A real AbortController, not just a losing Promise.race: without this,
  // a timed-out rerank call keeps running against OpenAI in the background
  // (and getting billed) even though hybridRetrieve has already moved on to
  // the conservative-gate fallback.
  const controller = new AbortController();
  const timer = timeoutMs
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;

  try {
    const response = await createChatCompletion({
      model: RERANK_MODEL,
      safetyIdentifier: userId,
      signal: controller.signal,
      messages: [
        { role: "system", content: buildRerankSystemPrompt() },
        { role: "user", content: buildRerankUserPrompt(query, candidates) },
      ],
      responseSchema: {
        name: "rerank_result",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            scores: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  relevance_score: { type: "number", minimum: 0, maximum: 1 },
                },
                required: ["id", "relevance_score"],
              },
            },
          },
          required: ["scores"],
        },
      },
    });

    const knownIds = new Set(candidates.map((c) => c.id));
    const parsed = JSON.parse(response) as {
      scores: { id: string; relevance_score: number }[];
    };
    return new Map(
      parsed.scores
        .filter((s) => knownIds.has(s.id))
        .map((s) => [s.id, Math.min(1, Math.max(0, s.relevance_score))]),
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function passesConservativeGate(c: Candidate): boolean {
  return c.fts_rank > 0 || c.similarity >= CONSERVATIVE_VECTOR_THRESHOLD;
}

function sourceTokenCount(source: RetrievedSource): number {
  // Budget only the semantic source payload injected into answer prompts.
  // Transport IDs and ranking diagnostics do not consume context tokens.
  const promptSource =
    source.kind === "memory_item"
      ? {
          type: source.type,
          content: source.content,
          status: source.status,
          confidence: source.confidence,
          occurred_at: source.occurred_at,
        }
      : {
          type: "kontext_beschreibung",
          name: source.name,
          description: source.description,
        };
  return retrievalEncoding.encode(JSON.stringify(promptSource)).length;
}

function applyTokenBudget(
  sources: RetrievedSource[],
  maxTokens: number,
  candidateCount: number,
): RetrievalResult {
  const selected: RetrievedSource[] = [];
  let usedTokens = 0;

  for (const source of sources) {
    const sourceTokens = sourceTokenCount(source);
    if (usedTokens + sourceTokens > maxTokens) continue;
    selected.push(source);
    usedTokens += sourceTokens;
  }

  return {
    sources: selected,
    usage: {
      usedTokens,
      maxTokens,
      candidateCount,
      selectedCount: selected.length,
      truncated: selected.length < sources.length,
    },
  };
}

export async function hybridRetrieve(params: {
  supabase: SupabaseClient;
  query: string;
  contextSpaceId: string;
  userId: string;
  memoryCandidateCount?: number;
  contextCandidateCount?: number;
  tokenBudget?: number;
  minScore?: number;
  filters?: RetrievalFilters;
  rerank?: RerankMode;
}): Promise<RetrievalResult> {
  const {
    supabase,
    contextSpaceId,
    userId,
    memoryCandidateCount = DEFAULT_MEMORY_CANDIDATE_COUNT,
    contextCandidateCount = DEFAULT_CONTEXT_CANDIDATE_COUNT,
    tokenBudget = DEFAULT_RETRIEVAL_TOKEN_BUDGET,
    minScore = DEFAULT_MIN_RELEVANCE,
    filters,
    rerank = { mode: "llm" },
  } = params;
  const query = params.query.slice(0, MAX_QUERY_LENGTH);

  // Best effort: an embedding failure shouldn't take full-text search down
  // with it — the RPCs treat a null query_embedding as "vector leg
  // contributes nothing", so FTS alone still drives the fused ranking.
  let queryEmbedding: number[] | null;
  try {
    [queryEmbedding] = await createEmbeddings([query], userId);
  } catch {
    queryEmbedding = null;
  }

  const [memoryItemsResult, contextsResult] = await Promise.all([
    supabase.rpc("match_memory_items", {
      query_embedding: queryEmbedding,
      query_text: query,
      match_context_space_id: contextSpaceId,
      match_count: memoryCandidateCount,
      match_types: filters?.types ?? null,
      match_context_id: filters?.contextId ?? null,
      match_occurred_from: filters?.occurredFrom ?? null,
      match_occurred_to: filters?.occurredTo ?? null,
    }),
    supabase.rpc("match_contexts", {
      query_embedding: queryEmbedding,
      query_text: query,
      match_context_space_id: contextSpaceId,
      match_count: contextCandidateCount,
      match_context_id: filters?.contextId ?? null,
    }),
  ]);

  if (memoryItemsResult.error) throw new Error(memoryItemsResult.error.message);
  if (contextsResult.error) throw new Error(contextsResult.error.message);

  const memoryItemRows = (memoryItemsResult.data ??
    []) as MemoryItemCandidateRow[];
  const contextRows = (contextsResult.data ?? []) as ContextCandidateRow[];

  const candidates: Candidate[] = [
    ...memoryItemRows.map((row) => ({ ...row, kind: "memory_item" as const })),
    ...contextRows.map((row) => ({ ...row, kind: "context" as const })),
  ];

  if (candidates.length === 0) {
    return { sources: [], usage: emptyRetrievalUsage(tokenBudget) };
  }

  let relevanceById: Map<string, number> | null = null;
  if (rerank.mode === "llm") {
    try {
      relevanceById = await rerankCandidates(
        query,
        candidates,
        userId,
        rerank.timeoutMs,
      );
    } catch {
      // Reranking is an enhancement, not the source of truth for whether
      // retrieval works at all (network error, or the timeoutMs race above
      // lost) — fall through to RRF ordering via the conservative gate below.
      relevanceById = null;
    }
  }

  const scored = candidates.map((c): RetrievedSource => {
    const relevance_score = relevanceById?.get(c.id) ?? c.fused_score;
    return c.kind === "memory_item"
      ? { ...c, kind: "memory_item", relevance_score }
      : { ...c, kind: "context", relevance_score };
  });

  const eligible = candidates
    .map((candidate, i) => ({ candidate, source: scored[i] }))
    .filter(({ candidate, source }) =>
      // When reranking succeeded, the LLM has read the actual candidate
      // content against the actual query — that is itself grounding, not a
      // guess, so it is trusted on its own against minScore. Double-gating
      // it behind the raw lexical/vector floor as well (as this used to do)
      // caused real, live false negatives: correct rerank-confirmed matches
      // were still discarded for lacking literal keyword overlap or a high
      // enough cosine score. The conservative gate now only guards the
      // no-reranker fallback path, where nothing else has verified grounding.
      relevanceById !== null
        ? source.relevance_score >= minScore
        : passesConservativeGate(candidate),
    )
    .sort((a, b) => b.source.relevance_score - a.source.relevance_score)
    .map(({ source }) => source);

  return applyTokenBudget(eligible, tokenBudget, candidates.length);
}
