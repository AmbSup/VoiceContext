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

interface InboxMemoryItemRow {
  id: string;
  type: string;
  content: string;
  status: string;
  confidence: string | null;
  occurred_at: string;
  memory_context_links: { context_id: string }[];
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

  const [{ data: memoryItems }, { data: contexts }] = await Promise.all([
    supabase
      .from("memory_items")
      .select(
        "id, type, content, status, confidence, occurred_at, memory_context_links(context_id)",
      )
      .eq("context_space_id", contextSpaceId)
      .order("occurred_at", { ascending: false }),
    supabase
      .from("contexts")
      .select("id, name")
      .eq("context_space_id", contextSpaceId)
      .order("name", { ascending: true }),
  ]);

  // Inbox = Memory-Items ohne jede Kontext-Zuordnung (siehe CONTEXT.md
  // "Inbox") — nicht über eine eigene Spalte modelliert, sondern daran
  // erkennbar, dass memory_context_links für sie leer ist.
  const inboxItems = ((memoryItems ?? []) as InboxMemoryItemRow[]).filter(
    (item) => item.memory_context_links.length === 0,
  );
  const contextOptions = contexts ?? [];

  return (
    <>
      <AppNav current="/inbox" />
      <div className="flex flex-1 flex-col items-center gap-8 bg-zinc-50 px-6 py-12 dark:bg-black">
        <div className="w-full max-w-2xl">
          <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
            Inbox
          </h1>
          <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
            Memory-Items, die beim Erfassen keinem Kontext zugeordnet werden
            konnten. Ordne sie hier manuell zu.
          </p>

          <ul className="flex flex-col gap-3">
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
      </div>
    </>
  );
}
