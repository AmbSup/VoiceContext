import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { AppNav } from "@/components/app-nav";
import { ENTITY_TYPES, formatEntityType } from "@/lib/entities";
import { RevertMergeButton } from "./revert-merge-button";

interface EntityRow {
  id: string;
  name: string;
  type: string;
  merged_into_entity_id: string | null;
  memory_entity_links: { count: number }[];
}

interface EntityMergeRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  merged_at: string;
}

export default async function EntitiesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  const { data: entities, error: entitiesError } = await supabase
    .from("entities")
    .select("id, name, type, merged_into_entity_id, memory_entity_links(count)")
    .eq("context_space_id", contextSpaceId)
    .order("name", { ascending: true });
  if (entitiesError) throw new Error(entitiesError.message);

  const entityRows = (entities ?? []) as EntityRow[];
  const entityById = new Map(entityRows.map((entity) => [entity.id, entity]));
  const canonicalEntities = entityRows.filter(
    (entity) => entity.merged_into_entity_id === null,
  );
  const canonicalEntityIds = canonicalEntities.map((entity) => entity.id);

  // entity_merges has no context_space_id of its own — scoped via the
  // already-space-filtered canonical entity ids above rather than a
  // second RLS-only round trip.
  const { data: merges, error: mergesError } = canonicalEntityIds.length
    ? await supabase
        .from("entity_merges")
        .select("id, source_entity_id, target_entity_id, merged_at")
        .in("target_entity_id", canonicalEntityIds)
        .is("reverted_at", null)
        .order("merged_at", { ascending: false })
    : { data: [], error: null };
  if (mergesError) throw new Error(mergesError.message);

  const mergesByTarget = new Map<string, EntityMergeRow[]>();
  for (const merge of (merges ?? []) as EntityMergeRow[]) {
    const list = mergesByTarget.get(merge.target_entity_id) ?? [];
    list.push(merge);
    mergesByTarget.set(merge.target_entity_id, list);
  }

  const entitiesByType = new Map<string, EntityRow[]>();
  for (const entity of canonicalEntities) {
    const list = entitiesByType.get(entity.type) ?? [];
    list.push(entity);
    entitiesByType.set(entity.type, list);
  }

  return (
    <>
      <AppNav current="/entities" />
      <main className="app-page flex flex-1 flex-col items-center">
        <div className="w-full max-w-3xl">
          <p className="eyebrow">Wissensstruktur</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Entitäten
          </h1>
          <p className="mb-8 mt-2 text-base text-zinc-600 dark:text-zinc-400">
            Personen, Organisationen und Produkte, die über mehrere
            Memory-Items hinweg erkannt wurden (siehe CONTEXT.md „Entity“).
            Zusammenführungen — automatisch wie manuell bestätigt — lassen
            sich hier jederzeit rückgängig machen.
          </p>

          {canonicalEntities.length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-500">
              Noch keine Entitäten erkannt.
            </p>
          )}

          {ENTITY_TYPES.map((type) => {
            const entitiesOfType = entitiesByType.get(type);
            if (!entitiesOfType || entitiesOfType.length === 0) return null;
            return (
              <section key={type} className="mb-8">
                <h2 className="mb-3 text-lg font-semibold">
                  {formatEntityType(type)}
                </h2>
                <ul className="flex flex-col gap-3">
                  {entitiesOfType.map((entity) => {
                    const itemCount =
                      entity.memory_entity_links[0]?.count ?? 0;
                    const incomingMerges = mergesByTarget.get(entity.id) ?? [];
                    return (
                      <li
                        key={entity.id}
                        className="glass-card rounded-2xl p-5"
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <p className="min-w-0 flex-1 font-semibold text-black dark:text-zinc-50">
                            {entity.name}
                          </p>
                          <span className="shrink-0 rounded-full bg-violet-500/10 px-3 py-1.5 text-sm font-semibold text-violet-700 dark:text-violet-300">
                            {itemCount.toLocaleString("de-DE")}{" "}
                            {itemCount === 1 ? "Memory-Item" : "Memory-Items"}
                          </span>
                        </div>
                        {incomingMerges.length > 0 && (
                          <div className="mt-3 border-t border-black/[.06] pt-3 dark:border-white/[.08]">
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                              Zusammengeführt aus
                            </p>
                            <ul className="flex flex-col gap-2">
                              {incomingMerges.map((merge) => {
                                const sourceEntity = entityById.get(
                                  merge.source_entity_id,
                                );
                                return (
                                  <li
                                    key={merge.id}
                                    className="flex flex-wrap items-center gap-2 text-sm"
                                  >
                                    <span className="text-black dark:text-zinc-50">
                                      {sourceEntity?.name ?? "Unbekannt"}
                                    </span>
                                    <span className="text-xs text-zinc-400">
                                      {new Date(
                                        merge.merged_at,
                                      ).toLocaleString("de-DE")}
                                    </span>
                                    <span className="ml-auto" />
                                    <RevertMergeButton
                                      mergeId={merge.id}
                                      sourceName={sourceEntity?.name ?? "Entität"}
                                      targetName={entity.name}
                                    />
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </main>
    </>
  );
}
