import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { AppNav } from "@/components/app-nav";
import {
  formatMemoryItemConfidence,
  formatMemoryItemStatus,
  formatMemoryItemType,
  memoryItemStatusClasses,
} from "@/lib/memory-items";
import { DeleteMemoryItemButton } from "./delete-memory-item-button";

interface MemoryItemRow {
  id: string;
  type: string;
  content: string;
  status: string;
  confidence: string | null;
  occurred_at: string;
}

export default async function ContextDetailPage({
  params,
}: PageProps<"/contexts/[id]">) {
  const { id: contextId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  const { data: context } = await supabase
    .from("contexts")
    .select("id, name, description, created_at")
    .eq("id", contextId)
    .eq("context_space_id", contextSpaceId)
    .single();

  if (!context) {
    notFound();
  }

  const { data: memoryItems } = await supabase
    .from("memory_items")
    .select(
      "id, type, content, status, confidence, occurred_at, memory_context_links!inner(context_id)",
    )
    .eq("context_space_id", contextSpaceId)
    .eq("memory_context_links.context_id", contextId)
    .order("occurred_at", { ascending: false });

  const items = (memoryItems ?? []) as unknown as MemoryItemRow[];

  return (
    <>
      <AppNav current="/contexts" />
      <div className="flex flex-1 flex-col items-center gap-8 bg-zinc-50 px-6 py-12 dark:bg-black">
        <div className="w-full max-w-2xl">
          <Link
            href="/contexts"
            className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
          >
            ← Kontexte
          </Link>

          <h1 className="mt-2 text-xl font-semibold text-black dark:text-zinc-50">
            {context.name}
          </h1>
          {context.description && (
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {context.description}
            </p>
          )}

          <h2 className="mt-8 mb-3 text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Memory-Items{items.length > 0 ? ` (${items.length})` : ""}
          </h2>

          <ul className="flex flex-col gap-3">
            {items.length === 0 && (
              <li className="text-sm text-zinc-500 dark:text-zinc-500">
                Noch keine Memory-Items in diesem Kontext.
              </li>
            )}
            {items.map((item) => {
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
                    <DeleteMemoryItemButton
                      contextId={contextId}
                      memoryItemId={item.id}
                    />
                  </div>
                  <p className="mt-2 text-sm text-black dark:text-zinc-50">
                    {item.content}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </>
  );
}
