import type { SupabaseClient } from "@supabase/supabase-js";

// Entity resolution — MVP scope per ADR 0002 / CONTEXT.md "Entity":
// Stage 1: exact name match + alias list (resolveOrCreateEntity's first
// two lookups below).
// Stage 2: fuzzy matching as suggestion-only (never auto-applied except
// at very high confidence, see AUTO_MERGE_SIMILARITY_THRESHOLD) —
// 20260818090000_entity_merge_suggestions.sql. Full embedding-based
// resolution is V2.
//
// A merge is always a soft, reversible pointer (entities.merged_into_
// entity_id), never a destructive row rewrite (see 0001_init_schema.sql),
// so a name/alias hit always has to be followed to its current canonical
// entity before use.

export const ENTITY_TYPES = [
  "person",
  "organisation",
  "produkt",
  "sonstiges",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

const ENTITY_TYPE_LABELS: Record<string, string> = {
  person: "Person",
  organisation: "Organisation",
  produkt: "Produkt",
  sonstiges: "Sonstiges",
};

export function formatEntityType(type: string): string {
  return ENTITY_TYPE_LABELS[type] ?? type;
}

// Merge chains are expected to be one hop deep in practice; this is just a
// guard against a corrupted/cyclic chain looping forever.
const MAX_MERGE_HOPS = 10;

// Above this trigram similarity, two entity names are close enough that
// requiring manual confirmation would just be busywork (e.g. a trailing
// whitespace/case variant the exact-match ilike above didn't already
// catch) — ADR 0002's "automatischer Merge nur bei sehr hoher Konfidenz".
// Anything from here down to FUZZY_SUGGEST_SIMILARITY_THRESHOLD becomes a
// suggestion instead, never applied automatically.
const AUTO_MERGE_SIMILARITY_THRESHOLD = 0.92;
const FUZZY_SUGGEST_SIMILARITY_THRESHOLD = 0.4;
const FUZZY_CANDIDATE_COUNT = 3;

interface FuzzyMergeCandidate {
  id: string;
  name: string;
  similarity: number;
}

async function resolveCanonicalEntityId(
  supabase: SupabaseClient,
  entityId: string,
): Promise<string> {
  let currentId = entityId;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
    const { data, error } = await supabase
      .from("entities")
      .select("merged_into_entity_id")
      .eq("id", currentId)
      .maybeSingle();
    if (error || !data || !data.merged_into_entity_id) return currentId;
    currentId = data.merged_into_entity_id as string;
  }
  return currentId;
}

async function findFuzzyMergeCandidates(
  supabase: SupabaseClient,
  contextSpaceId: string,
  entityId: string,
  name: string,
  type: EntityType,
): Promise<FuzzyMergeCandidate[]> {
  const { data, error } = await supabase.rpc("match_entity_merge_candidates", {
    query_entity_id: entityId,
    query_name: name,
    query_type: type,
    match_context_space_id: contextSpaceId,
    similarity_threshold: FUZZY_SUGGEST_SIMILARITY_THRESHOLD,
    match_count: FUZZY_CANDIDATE_COUNT,
  });
  if (error) throw error;
  return (data ?? []) as FuzzyMergeCandidate[];
}

async function applyAutoMerge(
  supabase: SupabaseClient,
  sourceEntityId: string,
  targetEntityId: string,
  mergedBy: string,
): Promise<void> {
  const { error: updateError } = await supabase
    .from("entities")
    .update({ merged_into_entity_id: targetEntityId })
    .eq("id", sourceEntityId);
  if (updateError) throw updateError;

  const { error: logError } = await supabase.from("entity_merges").insert({
    source_entity_id: sourceEntityId,
    target_entity_id: targetEntityId,
    merged_by: mergedBy,
  });
  if (logError) throw logError;
}

// Best-effort, non-blocking: a race with another suggestion for the same
// pair just hits the unique index (entity_merge_suggestions_pair_idx) and
// throws, which the caller already treats as a skip.
async function createMergeSuggestion(
  supabase: SupabaseClient,
  contextSpaceId: string,
  sourceEntityId: string,
  targetEntityId: string,
  similarity: number,
): Promise<void> {
  const { data: existing, error: existingError } = await supabase
    .from("entity_merge_suggestions")
    .select("id")
    .eq("context_space_id", contextSpaceId)
    .or(
      `and(source_entity_id.eq.${sourceEntityId},target_entity_id.eq.${targetEntityId}),` +
        `and(source_entity_id.eq.${targetEntityId},target_entity_id.eq.${sourceEntityId})`,
    )
    .limit(1);
  if (existingError) throw existingError;
  if (existing && existing.length > 0) return;

  const { error: insertError } = await supabase
    .from("entity_merge_suggestions")
    .insert({
      context_space_id: contextSpaceId,
      source_entity_id: sourceEntityId,
      target_entity_id: targetEntityId,
      similarity,
    });
  if (insertError) throw insertError;
}

// Checks a brand-new entity against existing canonical ones of the same
// type for a near-duplicate name. Called only from the "no exact/alias
// match" branch below — an entity resolved by stage 1 is, by definition,
// already the same as something that exists, so there's nothing to check.
async function checkFuzzyMerge(
  supabase: SupabaseClient,
  contextSpaceId: string,
  newEntityId: string,
  name: string,
  type: EntityType,
  mergedBy: string,
): Promise<string> {
  const candidates = await findFuzzyMergeCandidates(
    supabase,
    contextSpaceId,
    newEntityId,
    name,
    type,
  );
  const best = candidates[0];
  if (best && best.similarity >= AUTO_MERGE_SIMILARITY_THRESHOLD) {
    await applyAutoMerge(supabase, newEntityId, best.id, mergedBy);
    return best.id;
  }
  for (const candidate of candidates) {
    await createMergeSuggestion(
      supabase,
      contextSpaceId,
      newEntityId,
      candidate.id,
      candidate.similarity,
    );
  }
  return newEntityId;
}

// Resolves `name`+`type` to an existing entity (by exact name or alias
// match, case-insensitive) or creates a new one — running the fuzzy-merge
// check (see above) on any newly created entity. `cache` is shared across
// one pipeline run so repeated mentions of the same entity within a batch
// don't re-query the database. `mergedBy` is the pipeline's `createdBy`
// (the context space's owner in MVP) — recorded as the actor on any
// automatic merge this call triggers.
export async function resolveOrCreateEntity(
  supabase: SupabaseClient,
  contextSpaceId: string,
  name: string,
  type: EntityType,
  cache: Map<string, string>,
  mergedBy: string,
): Promise<string | null> {
  const trimmed = name.trim().slice(0, 200);
  if (trimmed === "") return null;

  const cacheKey = `${type}::${trimmed.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { data: nameMatches, error: nameError } = await supabase
    .from("entities")
    .select("id")
    .eq("context_space_id", contextSpaceId)
    .eq("type", type)
    .ilike("name", trimmed)
    .limit(1);
  if (nameError) throw nameError;
  if (nameMatches && nameMatches.length > 0) {
    const canonicalId = await resolveCanonicalEntityId(
      supabase,
      nameMatches[0].id as string,
    );
    cache.set(cacheKey, canonicalId);
    return canonicalId;
  }

  const { data: aliasMatches, error: aliasError } = await supabase
    .from("entity_aliases")
    .select("entity_id, entities!inner(context_space_id, type)")
    .eq("entities.context_space_id", contextSpaceId)
    .eq("entities.type", type)
    .ilike("alias", trimmed)
    .limit(1);
  if (aliasError) throw aliasError;
  if (aliasMatches && aliasMatches.length > 0) {
    const canonicalId = await resolveCanonicalEntityId(
      supabase,
      aliasMatches[0].entity_id as string,
    );
    cache.set(cacheKey, canonicalId);
    return canonicalId;
  }

  const { data: created, error: insertError } = await supabase
    .from("entities")
    .insert({ context_space_id: contextSpaceId, name: trimmed, type })
    .select("id")
    .single();
  if (insertError || !created) {
    throw new Error(`Failed to create entity: ${insertError?.message}`);
  }

  let resolvedId = created.id as string;
  try {
    resolvedId = await checkFuzzyMerge(
      supabase,
      contextSpaceId,
      resolvedId,
      trimmed,
      type,
      mergedBy,
    );
  } catch (error) {
    console.error(
      `Fuzzy merge check failed for entity ${resolvedId} ("${trimmed}"):`,
      error,
    );
  }

  cache.set(cacheKey, resolvedId);
  return resolvedId;
}
