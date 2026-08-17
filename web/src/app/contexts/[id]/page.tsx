import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { AppNav } from "@/components/app-nav";
import {
  MemoryItemList,
  type ContextMemoryItem,
} from "./memory-item-list";

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

  const items = (memoryItems ?? []) as unknown as ContextMemoryItem[];

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

          <MemoryItemList contextId={contextId} items={items} />
        </div>
      </div>
    </>
  );
}
