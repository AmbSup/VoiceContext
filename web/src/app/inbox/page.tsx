import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { AppNav } from "@/components/app-nav";
import {
  formatMemoryItemConfidence,
  formatMemoryItemStatus,
  formatMemoryItemType,
  memoryItemStatusClasses,
} from "@/lib/memory-items";
import { AssignContextForm } from "./assign-context-form";
import { ContextPoolCard } from "./context-pool-card";
import { ConflictReviewCard } from "./conflict-review-card";
import { suggestContextPools } from "@/lib/context-suggestions";
import { DeleteMemoryItemButton } from "./delete-memory-item-button";

interface InboxMemoryItemRow {
  id: string;
  type: string;
  content: string;
  status: string;
  confidence: string | null;
  occurred_at: string;
  memory_context_links: { context_id: string }[];
}

interface ConflictReviewRow {
  id: string;
  new_memory_item_id: string;
  existing_memory_item_id: string;
  verdict: string;
  confidence: string;
}

export default async function InboxPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  const [
    { data: memoryItems },
    { data: contexts },
    { data: dismissedPoolItems },
    { data: conflictReviews },
  ] = await Promise.all([
    supabase
      .from("memory_items")
      .select(
        "id, type, content, status, confidence, occurred_at, memory_context_links(context_id)",
      )
      .eq("context_space_id", contextSpaceId)
      .order("occurred_at", { ascending: false }),
    supabase
      .from("contexts")
      .select("id, name, description")
      .eq("context_space_id", contextSpaceId)
      .order("name", { ascending: true }),
    supabase
      .from("dismissed_context_pool_items")
      .select("memory_item_id")
      .eq("user_id", user.id),
    supabase
      .from("memory_conflict_reviews")
      .select(
        "id, new_memory_item_id, existing_memory_item_id, verdict, confidence",
      )
      .eq("context_space_id", contextSpaceId)
      .eq("status", "offen")
      .order("created_at", { ascending: false }),
  ]);

  // Inbox = Memory-Items ohne jede Kontext-Zuordnung (siehe CONTEXT.md
  // "Inbox") — nicht über eine eigene Spalte modelliert, sondern daran
  // erkennbar, dass memory_context_links für sie leer ist.
  // status === "aktiv" excludes two cases that would otherwise slip into
  // "assignable Inbox entry": items flagged "unsicher" pending conflict
  // review (already surfaced, separately, under "Mögliche Konflikte" below
  // — letting them also be assigned/pooled here would let a user file one
  // away before its conflict is resolved) and "ueberholt" items (already
  // superseded, re-suggesting them for a context makes no sense).
  const inboxItems = ((memoryItems ?? []) as InboxMemoryItemRow[]).filter(
    (item) => item.memory_context_links.length === 0 && item.status === "aktiv",
  );
  const contextOptions = contexts ?? [];
  const dismissedPoolItemIds = new Set(
    (dismissedPoolItems ?? []).map((item) => item.memory_item_id as string),
  );
  const poolCandidates = inboxItems.filter(
    (item) => !dismissedPoolItemIds.has(item.id),
  );
  let suggestions: Awaited<ReturnType<typeof suggestContextPools>> = [];
  let suggestionsUnavailable = false;
  if (poolCandidates.length > 0) {
    try {
      suggestions = await suggestContextPools(
        poolCandidates.map(({ id, type, content }) => ({ id, type, content })),
        contextOptions,
        user.id,
      );
    } catch (error) {
      suggestionsUnavailable = true;
      console.error("Failed to suggest Inbox context pools:", error);
    }
  }
  const itemById = new Map(inboxItems.map((item) => [item.id, item]));

  // Both sides of a conflict review are looked up from the same
  // memory_items fetch above (already unfiltered/whole-space) rather than
  // a second query — every referenced item is in there by construction.
  const memoryItemById = new Map(
    ((memoryItems ?? []) as InboxMemoryItemRow[]).map((item) => [
      item.id,
      item,
    ]),
  );
  const resolvedConflictReviews = (
    (conflictReviews ?? []) as ConflictReviewRow[]
  )
    .map((review) => ({
      review,
      newItem: memoryItemById.get(review.new_memory_item_id),
      existingItem: memoryItemById.get(review.existing_memory_item_id),
    }))
    .filter(
      (
        entry,
      ): entry is typeof entry & {
        newItem: InboxMemoryItemRow;
        existingItem: InboxMemoryItemRow;
      } => entry.newItem !== undefined && entry.existingItem !== undefined,
    );

  return (
    <>
      <AppNav current="/inbox" />
      <main className="app-page flex flex-1 flex-col items-center">
        <div className="w-full max-w-6xl">
          <p className="eyebrow">Eingang</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Inbox
          </h1>
          <p className="mb-8 mt-2 text-base text-zinc-600 dark:text-zinc-400">
            Wir bündeln zusammengehörige Themen und schlagen passende Kontexte
            vor. Du bestätigst nur noch oder passt den Vorschlag an.
          </p>

          {resolvedConflictReviews.length > 0 && (
            <section className="mb-10">
              <div className="mb-4">
                <p className="eyebrow">Mögliche Konflikte</p>
                <h2 className="mt-2 text-2xl font-semibold">
                  {resolvedConflictReviews.length} neue Einträge zur Prüfung
                </h2>
                <p className="mt-1 text-sm text-zinc-500">
                  Neu erfasste Memory-Items, bei denen die automatische
                  Konflikterkennung sich nicht sicher genug war, um
                  selbstständig zu entscheiden.
                </p>
              </div>
              <ul className="grid items-start gap-4 lg:grid-cols-2">
                {resolvedConflictReviews.map(
                  ({ review, newItem, existingItem }) => (
                    <ConflictReviewCard
                      key={review.id}
                      reviewId={review.id}
                      verdict={review.verdict}
                      confidence={review.confidence}
                      newItem={newItem}
                      existingItem={existingItem}
                    />
                  ),
                )}
              </ul>
            </section>
          )}

          {suggestions.length > 0 && (
            <section className="mb-10">
              <div className="mb-4 flex items-end justify-between gap-4">
                <div>
                  <p className="eyebrow">Intelligente Bündelung</p>
                  <h2 className="mt-2 text-2xl font-semibold">
                    {suggestions.length} Themen-Pools vorgeschlagen
                  </h2>
                </div>
                <span className="text-sm text-zinc-500">
                  {inboxItems.length} Einträge analysiert
                </span>
              </div>
              <ul className="grid items-start gap-4 lg:grid-cols-2">
                {suggestions.map((pool, index) => {
                  const poolItems = pool.memory_item_ids
                    .map((id) => itemById.get(id))
                    .filter(
                      (item): item is InboxMemoryItemRow => item !== undefined,
                    );
                  return (
                    <ContextPoolCard
                      key={`${pool.title}-${index}`}
                      index={index}
                      title={pool.title}
                      reason={pool.reason}
                      itemIds={poolItems.map((item) => item.id)}
                      itemContents={poolItems.map((item) => item.content)}
                      recommendedContextId={
                        pool.recommended_existing_context_id
                      }
                      alternatives={pool.alternative_names}
                      contexts={contextOptions}
                    />
                  );
                })}
              </ul>
            </section>
          )}

          {suggestionsUnavailable && (
            <p className="mb-6 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              Vorschläge sind gerade nicht verfügbar. Die manuelle Zuordnung
              bleibt möglich.
            </p>
          )}

          {inboxItems.length > 0 && (
            <h2 className="mb-3 text-lg font-semibold">Einzelne Einträge</h2>
          )}

          <ul className="grid items-start gap-3 lg:grid-cols-2">
            {inboxItems.length === 0 && (
              <li className="text-sm text-zinc-500 dark:text-zinc-500">
                Inbox ist leer.
              </li>
            )}
            {inboxItems.map((item) => {
              const confidenceLabel = formatMemoryItemConfidence(
                item.confidence,
              );
              return (
                <li
                  key={item.id}
                  className="rounded-lg border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      {formatMemoryItemType(item.type)}
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${memoryItemStatusClasses(item.status)}`}
                    >
                      {formatMemoryItemStatus(item.status)}
                    </span>
                    {confidenceLabel && (
                      <span className="text-xs text-zinc-400 dark:text-zinc-500">
                        {confidenceLabel}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-zinc-400 dark:text-zinc-500">
                      {new Date(item.occurred_at).toLocaleString("de-DE")}
                    </span>
                    <DeleteMemoryItemButton memoryItemId={item.id} />
                  </div>
                  <p className="mt-2 text-sm text-black dark:text-zinc-50">
                    {item.content}
                  </p>

                  <AssignContextForm
                    memoryItemId={item.id}
                    contexts={contextOptions}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      </main>
    </>
  );
}
