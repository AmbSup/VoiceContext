"use server";

import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { createChatCompletion, createEmbeddings } from "@/lib/openai";

// Retrieval + Answer Engine (see docs/implementation-plan.md Phase 3).
// Modus A only ("nur persönlicher Kontext", see ADR 0002) — no internet,
// no Source Router. Vector similarity comes from the match_memory_items
// RPC (supabase/migrations/0010_match_memory_items.sql), which already
// enforces RLS since it isn't SECURITY DEFINER.

const ANSWER_MODEL = "gpt-4.1-mini";
const MATCH_COUNT = 8;

export interface SearchSource {
  id: string;
  type: string;
  content: string;
  status: string;
  confidence: string | null;
  occurred_at: string;
  similarity: number;
  contexts: { id: string; name: string }[];
}

export interface SearchState {
  error?: string;
  result?: {
    query: string;
    answer: string;
    sources: SearchSource[];
  };
}

function buildAnswerSystemPrompt(): string {
  return `Du bist die Answer Engine einer persönlichen Wissens-App (KI Voice Context Engine). Du bekommst eine Frage des Nutzers sowie eine Liste von Memory-Items, die per Vektorsuche als potenziell relevant gefunden wurden (Modus A: nur persönlicher Kontext, siehe ADR 0002 — kein Internet, keine anderen Quellen).

Regeln:
- Antworte ausschließlich auf Deutsch, in Prosa, klar und knapp.
- Stütze dich ausschließlich auf die bereitgestellten Memory-Items. Wenn sie die Frage nicht beantworten, sag das explizit, statt zu spekulieren.
- Ignoriere Memory-Items, die per Vektorsuche zwar ähnlich, aber inhaltlich nicht wirklich relevant sind.
- Erfinde keine Fakten und keine Details, die nicht in den Memory-Items stehen.`;
}

function buildAnswerUserPrompt(
  query: string,
  sources: Omit<SearchSource, "contexts">[],
): string {
  const items = sources.map((s) => ({
    type: s.type,
    content: s.content,
    status: s.status,
    occurred_at: s.occurred_at,
  }));
  return `## Frage\n${query}\n\n## Gefundene Memory-Items\n${JSON.stringify(items)}`;
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
    const [queryEmbedding] = await createEmbeddings([query], user.id);

    const { data: matches, error: matchError } = await supabase.rpc(
      "match_memory_items",
      {
        query_embedding: queryEmbedding,
        match_context_space_id: contextSpaceId,
        match_count: MATCH_COUNT,
      },
    );
    if (matchError) throw new Error(matchError.message);

    const sourceRows = (matches ?? []) as Omit<SearchSource, "contexts">[];

    if (sourceRows.length === 0) {
      return {
        result: {
          query,
          answer:
            "Dazu habe ich noch nichts in deinem Wissen gefunden. Entweder wurde es noch nicht erfasst, oder es liegt noch nicht lange genug zurück, um verarbeitet zu sein.",
          sources: [],
        },
      };
    }

    const { data: links } = await supabase
      .from("memory_context_links")
      .select("memory_item_id, contexts(id, name)")
      .in(
        "memory_item_id",
        sourceRows.map((s) => s.id),
      );

    const contextsByItem = new Map<string, { id: string; name: string }[]>();
    for (const link of (links ?? []) as unknown as ContextLinkRow[]) {
      if (!link.contexts) continue;
      const list = contextsByItem.get(link.memory_item_id) ?? [];
      list.push(link.contexts);
      contextsByItem.set(link.memory_item_id, list);
    }

    const sources: SearchSource[] = sourceRows.map((row) => ({
      ...row,
      contexts: contextsByItem.get(row.id) ?? [],
    }));

    const answer = await createChatCompletion({
      model: ANSWER_MODEL,
      safetyIdentifier: user.id,
      messages: [
        { role: "system", content: buildAnswerSystemPrompt() },
        { role: "user", content: buildAnswerUserPrompt(query, sourceRows) },
      ],
    });

    return { result: { query, answer, sources } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
