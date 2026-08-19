"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { ENTITY_TYPES, type EntityType } from "@/lib/entities";

interface RevertEntityMergeRpcResult {
  result_status: "ok" | "error";
  result_message: string | null;
}

// Delegates to the revert_entity_merge SQL RPC (20260818090000_entity_
// merge_suggestions.sql) — reversibility for every merge, automatic or
// manual, per ADR 0002. RLS on entities/entity_merges (SECURITY INVOKER)
// is what actually keeps this scoped to the caller's own context space.
export async function revertEntityMerge(
  mergeId: string,
): Promise<string | undefined> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "Nicht angemeldet";
  if (!mergeId) return "Zusammenführung fehlt";

  const { data, error } = await supabase
    .rpc("revert_entity_merge", { p_merge_id: mergeId })
    .single<RevertEntityMergeRpcResult>();
  if (error) return error.message;
  if (data?.result_status === "error") {
    return data.result_message ?? "Zusammenführung konnte nicht rückgängig gemacht werden";
  }

  revalidatePath("/entities");
  return undefined;
}

// Manual creation — everything else in entities.ts only ever creates a row
// as a side effect of extraction (resolveOrCreateEntity). This is the
// counterpart for a person/org/product the user knows about but that
// hasn't come up in a captured conversation or document yet.
export async function createEntity(
  _state: string | undefined,
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

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  const { error } = await supabase.from("entities").insert({
    context_space_id: contextSpaceId,
    name,
    type,
  });
  if (error) return error.message;

  revalidatePath("/entities");
  return undefined;
}
