"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { ENTITY_TYPES, type EntityType } from "@/lib/entities";

interface MergeEntitiesRpcResult {
  result_status: "ok" | "error";
  result_message: string | null;
}

export async function updateEntity(
  entityId: string,
  formData: FormData,
): Promise<string | undefined> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "Nicht angemeldet";

  const name = (formData.get("name") as string | null)?.trim();
  if (!name) return "Name ist erforderlich";
  const type = formData.get("type") as string | null;
  if (!type || !ENTITY_TYPES.includes(type as EntityType)) {
    return "Ungültiger Typ";
  }

  const { error } = await supabase
    .from("entities")
    .update({ name, type })
    .eq("id", entityId);
  if (error) return error.message;

  revalidatePath(`/entities/${entityId}`);
  revalidatePath("/entities");
  return undefined;
}

// entity_aliases exists in the schema and is checked by
// web/src/lib/entities.ts's resolveOrCreateEntity, but until this, nothing
// ever wrote to it — the exact-match alias path was entirely dead. This is
// how a user teaches the resolver that e.g. "Bob" and "Robert Müller" are
// the same person, so the next mention of "Bob" resolves directly instead
// of creating a near-duplicate for the fuzzy matcher to catch later.
export async function addAlias(
  entityId: string,
  formData: FormData,
): Promise<string | undefined> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "Nicht angemeldet";

  const alias = (formData.get("alias") as string | null)?.trim();
  if (!alias) return "Alias ist erforderlich";

  const { error } = await supabase
    .from("entity_aliases")
    .insert({ entity_id: entityId, alias });
  if (error) return error.message;

  revalidatePath(`/entities/${entityId}`);
  return undefined;
}

export async function removeAlias(
  aliasId: string,
  entityId: string,
): Promise<string | undefined> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "Nicht angemeldet";

  const { error } = await supabase
    .from("entity_aliases")
    .delete()
    .eq("id", aliasId);
  if (error) return error.message;

  revalidatePath(`/entities/${entityId}`);
  return undefined;
}

// Manual counterpart to the fuzzy-match suggestion flow on /inbox — for a
// duplicate the automatic matcher never flagged (similarity below its
// suggestion threshold, or two entities of a type it can't compare well).
export async function mergeEntity(
  sourceEntityId: string,
  targetEntityId: string,
): Promise<string | undefined> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "Nicht angemeldet";
  if (!targetEntityId) return "Ziel-Entität fehlt";

  const { data, error } = await supabase
    .rpc("merge_entities", {
      p_source_entity_id: sourceEntityId,
      p_target_entity_id: targetEntityId,
    })
    .single<MergeEntitiesRpcResult>();
  if (error) return error.message;
  if (data?.result_status === "error") {
    return data.result_message ?? "Zusammenführung fehlgeschlagen";
  }

  revalidatePath(`/entities/${sourceEntityId}`);
  revalidatePath("/entities");
  return undefined;
}

// For the "mit welcher Entität zusammenführen" picker — other canonical
// entities of the same type in the same context space, excluding self.
export async function listMergeCandidates(
  entityId: string,
  type: string,
): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);
  const { data, error } = await supabase
    .from("entities")
    .select("id, name")
    .eq("context_space_id", contextSpaceId)
    .eq("type", type)
    .is("merged_into_entity_id", null)
    .neq("id", entityId)
    .order("name", { ascending: true });
  if (error) return [];
  return (data ?? []) as { id: string; name: string }[];
}
