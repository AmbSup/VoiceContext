"use server";

import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { createChatCompletion } from "@/lib/openai";
import {
  hybridRetrieve,
  type RetrievalUsage,
  type RetrievedContext,
  type RetrievedMemoryItem,
  type RetrievedSegment,
} from "@/lib/retrieval";

// Retrieval + Answer Engine (see docs/implementation-plan.md Phase 3).
// Modus A only ("nur persönlicher Kontext", see ADR 0002) — no internet,
// no Source Router. Hybrid Retrieval (embeddings + Postgres full-text
// search, RRF-fused, LLM-reranked, Mindestscore-gefiltert) lives in
// web/src/lib/retrieval.ts — see supabase/migrations/
// 0013_hybrid_retrieval.sql for why pure vector search wasn't enough
// (unreliable for names, exact phrases, dates).
//
// Kontext name/description are searched alongside Memory-Items: CONTEXT.md
// treats a Kontext as "nur" an organizing node, not a knowledge container,
// but in practice a fact typed only into a Beschreibung (never captured as
// an actual Memory-Item) was otherwise invisible to Suche — confirmed by a
// user hitting exactly that wall.

const ANSWER_MODEL = "gpt-4.1-mini";
export interface MemoryItemSource extends RetrievedMemoryItem {
  contexts: { id: string; name: string }[];
}

export type ContextSource = RetrievedContext;
export type SegmentSource = RetrievedSegment;

export type SearchSource = MemoryItemSource | ContextSource | SegmentSource;

export interface SearchState {
  error?: string;
  result?: {
    query: string;
    answer: string;
    sources: SearchSource[];
    retrievalUsage: RetrievalUsage;
  };
}

function buildAnswerSystemPrompt(): string {
  return `Du bist die Answer Engine einer persönlichen Wissens-App (KI Voice Context Engine). Du bekommst eine Frage des Nutzers sowie eine Liste von Informationen (Memory-Items und/oder Kontext-Beschreibungen), die per Vektorsuche als potenziell relevant gefunden wurden (Modus A: nur persönlicher Kontext, siehe ADR 0002 — kein Internet, keine anderen Quellen).

Regeln:
- Antworte ausschließlich auf Deutsch, in Prosa, klar und knapp.
- Stütze dich ausschließlich auf die bereitgestellten Informationen. Wenn sie die Frage nicht beantworten, sag das explizit, statt zu spekulieren.
- Ignoriere Einträge, die per Vektorsuche zwar ähnlich, aber inhaltlich nicht wirklich relevant sind.
- Erfinde keine Fakten und keine Details, die nicht in den bereitgestellten Informationen stehen.`;
}

function buildAnswerUserPrompt(query: string, sources: SearchSource[]): string {
  const items = sources.map((s) => {
    switch (s.kind) {
      case "memory_item":
        return {
          type: s.type,
          content: s.content,
          status: s.status,
          occurred_at: s.occurred_at,
        };
      case "segment":
        return { type: "segment", content: s.content };
      case "context":
        return {
          type: "kontext_beschreibung",
          content: s.description ? `${s.name}: ${s.description}` : s.name,
        };
    }
  });
  return `## Frage\n${query}\n\n## Gefundene Informationen\n${JSON.stringify(items)}`;
}

interface ContextLinkRow {
  memory_item_id: string;
  contexts: { id: string; name: string } | null;
}

export async function search(
  _state: SearchState | undefined,
  formData: FormData,
): Promise<SearchState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Nicht angemeldet" };

  const query = (formData.get("query") as string)?.trim();
  if (!query) return { error: "Frage darf nicht leer sein" };

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  try {
    const retrieval = await hybridRetrieve({
      supabase,
      query,
      contextSpaceId,
      userId: user.id,
      // No hard latency budget here (unlike the live voice path), so a
      // plain, untimed LLM rerank pass is fine.
      rerank: { mode: "llm" },
    });
    const memoryItemRows = retrieval.sources.filter(
      (s): s is RetrievedMemoryItem => s.kind === "memory_item",
    );
    const contextRows = retrieval.sources.filter(
      (s): s is ContextSource => s.kind === "context",
    );
    const segmentRows = retrieval.sources.filter(
      (s): s is SegmentSource => s.kind === "segment",
    );

    if (
      memoryItemRows.length === 0 &&
      contextRows.length === 0 &&
      segmentRows.length === 0
    ) {
      return {
        result: {
          query,
          answer:
            "Dazu habe ich noch nichts in deinem Wissen gefunden. Entweder wurde es noch nicht erfasst, oder es liegt noch nicht lange genug zurück, um verarbeitet zu sein.",
          sources: [],
          retrievalUsage: retrieval.usage,
        },
      };
    }

    const { data: links } = await supabase
      .from("memory_context_links")
      .select("memory_item_id, contexts(id, name)")
      .in(
        "memory_item_id",
        memoryItemRows.map((s) => s.id),
      );

    const contextsByItem = new Map<string, { id: string; name: string }[]>();
    for (const link of (links ?? []) as unknown as ContextLinkRow[]) {
      if (!link.contexts) continue;
      const list = contextsByItem.get(link.memory_item_id) ?? [];
      list.push(link.contexts);
      contextsByItem.set(link.memory_item_id, list);
    }

    const sources: SearchSource[] = [
      ...memoryItemRows.map(
        (row): MemoryItemSource => ({ ...row, contexts: contextsByItem.get(row.id) ?? [] }),
      ),
      ...contextRows,
      ...segmentRows,
    ];

    const answer = await createChatCompletion({
      model: ANSWER_MODEL,
      safetyIdentifier: user.id,
      messages: [
        { role: "system", content: buildAnswerSystemPrompt() },
        { role: "user", content: buildAnswerUserPrompt(query, sources) },
      ],
    });

    return {
      result: { query, answer, sources, retrievalUsage: retrieval.usage },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
