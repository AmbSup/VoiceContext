import { createChatCompletion } from "@/lib/openai";

const SUGGESTION_MODEL = "gpt-4.1-mini";

export interface SuggestionMemoryItem {
  id: string;
  type: string;
  content: string;
}

export interface SuggestionContext {
  id: string;
  name: string;
  description: string | null;
}

export interface ContextPoolSuggestion {
  title: string;
  reason: string;
  memory_item_ids: string[];
  recommended_existing_context_id: string | null;
  alternative_names: string[];
}

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pools: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          reason: { type: "string" },
          memory_item_ids: { type: "array", items: { type: "string" } },
          recommended_existing_context_id: { type: ["string", "null"] },
          alternative_names: {
            type: "array",
            items: { type: "string" },
            maxItems: 3,
          },
        },
        required: [
          "title",
          "reason",
          "memory_item_ids",
          "recommended_existing_context_id",
          "alternative_names",
        ],
      },
    },
  },
  required: ["pools"],
} as const;

export async function suggestContextPools(
  items: SuggestionMemoryItem[],
  contexts: SuggestionContext[],
  safetyIdentifier: string,
): Promise<ContextPoolSuggestion[]> {
  if (items.length === 0) return [];

  const content = await createChatCompletion({
    model: SUGGESTION_MODEL,
    safetyIdentifier,
    responseSchema: { name: "context_pool_suggestions", schema: RESPONSE_SCHEMA },
    messages: [
      {
        role: "system",
        content: `Du organisierst die Inbox einer persönlichen Wissens-App in Kontexte.

Bilde aus den Memory-Items die kleinste sinnvolle Anzahl klarer Themen-Pools. Bündele eng verwandte Aussagen, Entscheidungen, Aufgaben und Fragen. Vermeide sowohl einen riesigen unspezifischen Sammelkontext als auch Mikro-Kontexte für einzelne Items. Ein Pool soll voraussichtlich auch für künftige Einträge nützlich sein.

Regeln:
- Jedes gelieferte Memory-Item muss genau einmal vorkommen.
- Verwende ausschließlich gelieferte IDs.
- Wenn ein bestehender Kontext fachlich gut passt, empfehle dessen ID.
- Sonst schlage einen kurzen, dauerhaften deutschen Kontextnamen vor.
- title ist bei bestehendem Kontext dessen exakter Name, sonst der beste neue Name.
- alternative_names enthält bis zu drei kurze Alternativen, ohne Duplikate.
- reason erklärt in einem kurzen Satz, warum diese Items zusammengehören.
- Sortiere größere und klarere Pools zuerst.`,
      },
      {
        role: "user",
        content: JSON.stringify({ memory_items: items, existing_contexts: contexts }),
      },
    ],
  });

  const parsed = JSON.parse(content) as { pools?: ContextPoolSuggestion[] };
  const validItemIds = new Set(items.map((item) => item.id));
  const validContextIds = new Set(contexts.map((context) => context.id));
  const usedItemIds = new Set<string>();

  const pools = (parsed.pools ?? []).flatMap((pool) => {
    const itemIds = pool.memory_item_ids.filter(
      (id) => validItemIds.has(id) && !usedItemIds.has(id),
    );
    if (itemIds.length === 0 || !pool.title.trim()) return [];
    itemIds.forEach((id) => usedItemIds.add(id));
    return [{
      ...pool,
      title: pool.title.trim(),
      reason: pool.reason.trim(),
      memory_item_ids: itemIds,
      recommended_existing_context_id:
        pool.recommended_existing_context_id &&
        validContextIds.has(pool.recommended_existing_context_id)
          ? pool.recommended_existing_context_id
          : null,
      alternative_names: pool.alternative_names
        .map((name) => name.trim())
        .filter((name) => name && name !== pool.title.trim())
        .slice(0, 3),
    }];
  });

  // Never hide an Inbox item because of a malformed model response.
  for (const item of items) {
    if (!usedItemIds.has(item.id)) {
      pools.push({
        title: item.content.slice(0, 60),
        reason: "Dieses Thema konnte keinem anderen Pool sicher zugeordnet werden.",
        memory_item_ids: [item.id],
        recommended_existing_context_id: null,
        alternative_names: [],
      });
    }
  }
  return pools;
}
