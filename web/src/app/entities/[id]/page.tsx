import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { AppNav } from "@/components/app-nav";
import { formatEntityType } from "@/lib/entities";
import { RevertMergeButton } from "../revert-merge-button";
import { EditEntityForm } from "./edit-entity-form";
import { AliasManager } from "./alias-manager";
import { MergeEntityForm } from "./merge-entity-form";
import { listMergeCandidates } from "./actions";

interface EntityMemoryItem {
  id: string;
  type: string;
  content: string;
  status: string;
  occurred_at: string;
}

interface EntityMergeRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  merged_at: string;
}

export default async function EntityDetailPage({
  params,
}: PageProps<"/entities/[id]">) {
  const { id: entityId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  const { data: entity } = await supabase
    .from("entities")
    .select("id, name, type, merged_into_entity_id")
    .eq("id", entityId)
    .eq("context_space_id", contextSpaceId)
    .single();

  if (!entity) {
    notFound();
  }

  const [
    { data: memoryItems },
    { data: aliases },
    { data: mergedIntoEntity },
    { data: incomingMerges },
  ] = await Promise.all([
    supabase
      .from("memory_items")
      .select(
        "id, type, content, status, occurred_at, memory_entity_links!inner(entity_id)",
      )
      .eq("context_space_id", contextSpaceId)
      .eq("memory_entity_links.entity_id", entityId)
      .order("occurred_at", { ascending: false })
      .limit(50),
    supabase
      .from("entity_aliases")
      .select("id, alias")
      .eq("entity_id", entityId)
      .order("alias", { ascending: true }),
    entity.merged_into_entity_id
      ? supabase
          .from("entities")
          .select("id, name")
          .eq("id", entity.merged_into_entity_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    entity.merged_into_entity_id
      ? Promise.resolve({ data: [] as EntityMergeRow[] })
      : supabase
          .from("entity_merges")
          .select("id, source_entity_id, target_entity_id, merged_at")
          .eq("target_entity_id", entityId)
          .is("reverted_at", null)
          .order("merged_at", { ascending: false }),
  ]);

  let sourceNamesById = new Map<string, string>();
  if (incomingMerges && incomingMerges.length > 0) {
    const sourceIds = incomingMerges.map((m) => m.source_entity_id);
    const { data: sourceEntities } = await supabase
      .from("entities")
      .select("id, name")
      .in("id", sourceIds);
    sourceNamesById = new Map(
      (sourceEntities ?? []).map((e) => [e.id, e.name as string]),
    );
  }

  const isMerged = entity.merged_into_entity_id !== null;
  const items = (memoryItems ?? []) as unknown as EntityMemoryItem[];
  const mergeCandidates = isMerged
    ? []
    : await listMergeCandidates(entity.id, entity.type);

  return (
    <>
      <AppNav current="/entities" />
      <main className="app-page flex flex-1 flex-col items-center">
        <div className="w-full max-w-2xl">
          <Link
            href="/entities"
            className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
          >
            ← Entitäten
          </Link>

          <div className="mt-2 flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
              {entity.name}
            </h1>
            <span className="rounded-full bg-violet-500/10 px-3 py-1 text-sm font-semibold text-violet-700 dark:text-violet-300">
              {formatEntityType(entity.type)}
            </span>
          </div>

          {isMerged && (
            <p className="mt-4 rounded-lg border border-black/[.08] bg-black/[.02] p-4 text-sm text-zinc-600 dark:border-white/[.145] dark:bg-white/[.04] dark:text-zinc-400">
              Diese Entität wurde zusammengeführt in{" "}
              {mergedIntoEntity ? (
                <Link
                  href={`/entities/${mergedIntoEntity.id}`}
                  className="font-medium text-violet-700 hover:underline dark:text-violet-300"
                >
                  {mergedIntoEntity.name}
                </Link>
              ) : (
                "eine andere Entität"
              )}
              . Bearbeiten und Zusammenführen sind erst nach dem Rückgängigmachen
              auf der Zielseite wieder möglich.
            </p>
          )}

          {!isMerged && (
            <>
              <section className="mt-6">
                <EditEntityForm
                  entityId={entity.id}
                  name={entity.name}
                  type={entity.type}
                />
              </section>

              <section className="mt-8">
                <AliasManager
                  entityId={entity.id}
                  aliases={(aliases ?? []) as { id: string; alias: string }[]}
                />
              </section>

              <section className="mt-8">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Mit anderer Entität zusammenführen
                </p>
                <MergeEntityForm
                  entityId={entity.id}
                  entityName={entity.name}
                  candidates={mergeCandidates}
                />
              </section>

              {incomingMerges && incomingMerges.length > 0 && (
                <section className="mt-8">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Zusammengeführt aus
                  </p>
                  <ul className="flex flex-col gap-2">
                    {incomingMerges.map((merge) => {
                      const sourceName =
                        sourceNamesById.get(merge.source_entity_id) ??
                        "Unbekannt";
                      return (
                        <li
                          key={merge.id}
                          className="flex flex-wrap items-center gap-2 rounded-lg border border-black/[.08] p-3 text-sm dark:border-white/[.145]"
                        >
                          <span className="text-black dark:text-zinc-50">
                            {sourceName}
                          </span>
                          <span className="text-xs text-zinc-400">
                            {new Date(merge.merged_at).toLocaleString("de-DE")}
                          </span>
                          <span className="ml-auto" />
                          <RevertMergeButton
                            mergeId={merge.id}
                            sourceName={sourceName}
                            targetName={entity.name}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </>
          )}

          <section className="mt-8">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Verknüpfte Memory-Items{items.length > 0 ? ` (${items.length})` : ""}
            </p>
            {items.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-500">
                Noch keine verknüpften Memory-Items.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="glass-card rounded-xl p-4 text-sm"
                  >
                    <div className="mb-1 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-500">
                      <span className="capitalize">{item.type}</span>
                      <span>·</span>
                      <span>{item.status}</span>
                      <span>·</span>
                      <span>
                        {new Date(item.occurred_at).toLocaleDateString("de-DE")}
                      </span>
                    </div>
                    <p className="text-black dark:text-zinc-50">
                      {item.content}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
