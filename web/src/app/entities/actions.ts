"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

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
