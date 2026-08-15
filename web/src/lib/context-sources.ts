import type { SupabaseClient } from "@supabase/supabase-js";
import { countTokens } from "./token-count";
import { getConfirmedActiveContext } from "./active-context";
import {
  isSessionMemoryNote,
  renderSessionBlock,
  type RecentSessionRow,
} from "./short-term-memory";

// Turn-Kontext-Auswahl: lists every context source a user could include when
// starting a Realtime Dialog-Session (the confirmed active context, other
// contexts, documents linked to a context, and recent sessions' short-term
// memory), each with a token cost, so the mobile app can offer per-source
// toggles with a live token-budget bar instead of the previous always-on
// active-context + always-on-last-3-sessions behavior.

export type ContextSourceKind = "active_context" | "context" | "document" | "session";

export interface ContextSource {
  id: string;
  kind: ContextSourceKind;
  label: string;
  meta: string;
  tokenCount: number;
  defaultEnabled: boolean;
  // Pre-rendered instruction text for this source. Only consumed server-side
  // (by realtime-token/route.ts) — stripped before the source list is ever
  // returned to a client.
  content: string;
}

export interface ContextSourcesResult {
  sources: ContextSource[];
  defaultEnabledSourceIds: string[];
  tokenBudget: number;
}

// Ceiling for the combined instructions block built from selected sources.
// Separate from SHORT_TERM_MEMORY_TOKEN_BUDGET (short-term-memory.ts), which
// only ever bounded the sessions slice of this same instructions block.
export const SOURCE_TOKEN_BUDGET = 4_000;

const RECENT_SESSION_LIMIT = 3;

interface ContextRow {
  id: string;
  name: string;
  description: string | null;
}

interface MemoryLinkRow {
  context_id: string;
  memory_items: { content: string } | null;
}

interface DocumentRow {
  id: string;
  context_id: string | null;
  file_name: string;
}

interface DocumentChunkRow {
  document_id: string;
  token_count: number;
  content: string;
}

// RecentSessionRow (short-term-memory.ts) doesn't include this column since
// loadShortTermMemory never selects it — this source list does, to avoid
// re-tokenizing a value dialog_sessions already stores precomputed.
type SessionSourceRow = RecentSessionRow & {
  short_term_memory_token_count: number | null;
};

export async function listContextSources(
  supabase: SupabaseClient,
  contextSpaceId: string,
  userId: string,
): Promise<ContextSourcesResult> {
  const [activeContext, contextsResult, sessionsResult] = await Promise.all([
    getConfirmedActiveContext(supabase, contextSpaceId, userId),
    supabase
      .from("contexts")
      .select("id, name, description")
      .eq("context_space_id", contextSpaceId),
    supabase
      .from("dialog_sessions")
      .select(
        "id, started_context_id, ended_at, full_transcript, short_term_memory, short_term_memory_token_count",
      )
      .eq("context_space_id", contextSpaceId)
      .not("ended_at", "is", null)
      .order("ended_at", { ascending: false })
      .limit(RECENT_SESSION_LIMIT),
  ]);
  if (contextsResult.error) throw new Error(contextsResult.error.message);
  if (sessionsResult.error) throw new Error(sessionsResult.error.message);

  const contextRows = (contextsResult.data ?? []) as ContextRow[];
  const contextIds = contextRows.map((c) => c.id);

  const [memoryLinksResult, documentsResult] = contextIds.length
    ? await Promise.all([
        supabase
          .from("memory_context_links")
          .select("context_id, memory_items!inner(content, status)")
          .in("context_id", contextIds)
          .eq("memory_items.status", "aktiv"),
        supabase
          .from("documents")
          .select("id, context_id, file_name")
          .eq("context_space_id", contextSpaceId)
          .in("context_id", contextIds),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
      ];
  if (memoryLinksResult.error) throw new Error(memoryLinksResult.error.message);
  if (documentsResult.error) throw new Error(documentsResult.error.message);

  const documentRows = (documentsResult.data ?? []) as DocumentRow[];
  const documentIds = documentRows.map((d) => d.id);
  const { data: chunkRows, error: chunkError } = documentIds.length
    ? await supabase
        .from("document_chunks")
        .select("document_id, token_count, content")
        .in("document_id", documentIds)
    : { data: [], error: null };
  if (chunkError) throw new Error(chunkError.message);

  const activeContentsByContext = new Map<string, string[]>();
  for (const link of (memoryLinksResult.data ?? []) as unknown as MemoryLinkRow[]) {
    if (!link.memory_items) continue;
    const contents = activeContentsByContext.get(link.context_id) ?? [];
    contents.push(link.memory_items.content);
    activeContentsByContext.set(link.context_id, contents);
  }
  // Same shape/token-counting convention as contexts/page.tsx's per-context
  // token badge — kept identical so a context's reported cost here matches
  // what the Kontexte page already shows the user.
  const tokenCountByContext = new Map(
    contextRows.map((context) => [
      context.id,
      countTokens(
        JSON.stringify({
          name: context.name,
          description: context.description,
          items: activeContentsByContext.get(context.id) ?? [],
        }),
      ),
    ]),
  );
  const contentByContext = new Map(
    contextRows.map((context) => [
      context.id,
      `### Kontext: ${context.name}\n${context.description ?? ""}\n${(activeContentsByContext.get(context.id) ?? []).join("\n")}`,
    ]),
  );

  const chunksByDocument = new Map<string, DocumentChunkRow[]>();
  for (const chunk of (chunkRows ?? []) as unknown as DocumentChunkRow[]) {
    const chunks = chunksByDocument.get(chunk.document_id) ?? [];
    chunks.push(chunk);
    chunksByDocument.set(chunk.document_id, chunks);
  }

  const sessionRows = (sessionsResult.data ?? []) as SessionSourceRow[];
  // Same promotion rule loadShortTermMemory already applies: the most
  // recent session overall is the baseline default; a session started in
  // the active context is promoted ahead of other, older sessions.
  const promotedSessionId = sessionRows.length
    ? (sessionRows.find((s) => s.started_context_id === activeContext?.id)?.id ??
      sessionRows[0].id)
    : null;

  const sources: ContextSource[] = [];
  const defaultEnabledSourceIds: string[] = [];

  if (activeContext) {
    sources.push({
      id: activeContext.id,
      kind: "active_context",
      label: activeContext.name,
      meta: "Standardkontext",
      tokenCount: tokenCountByContext.get(activeContext.id) ?? 0,
      defaultEnabled: true,
      content: contentByContext.get(activeContext.id) ?? "",
    });
    defaultEnabledSourceIds.push(activeContext.id);
  }

  for (const context of contextRows) {
    if (context.id === activeContext?.id) continue;
    sources.push({
      id: context.id,
      kind: "context",
      label: context.name,
      meta: context.description ?? "",
      tokenCount: tokenCountByContext.get(context.id) ?? 0,
      defaultEnabled: false,
      content: contentByContext.get(context.id) ?? "",
    });
  }

  for (const doc of documentRows) {
    const contextName = contextRows.find((c) => c.id === doc.context_id)?.name;
    const chunks = chunksByDocument.get(doc.id) ?? [];
    sources.push({
      id: doc.id,
      kind: "document",
      label: doc.file_name,
      meta: contextName ? `Kontext: ${contextName}` : "Dokument",
      tokenCount: chunks.reduce((sum, c) => sum + c.token_count, 0),
      defaultEnabled: false,
      content: `### Dokument: ${doc.file_name}\n${chunks.map((c) => c.content).join("\n\n")}`,
    });
  }

  for (const session of sessionRows) {
    const isDefault = session.id === promotedSessionId;
    sources.push({
      id: session.id,
      kind: "session",
      label: `Session vom ${new Date(session.ended_at).toLocaleDateString("de-DE")}`,
      meta: isSessionMemoryNote(session.short_term_memory)
        ? session.short_term_memory.summary
        : "Ohne Übergabe-Notiz",
      tokenCount: session.short_term_memory_token_count ?? 0,
      defaultEnabled: isDefault,
      content: renderSessionBlock(session),
    });
    if (isDefault) defaultEnabledSourceIds.push(session.id);
  }

  return { sources, defaultEnabledSourceIds, tokenBudget: SOURCE_TOKEN_BUDGET };
}
