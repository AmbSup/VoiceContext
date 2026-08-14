"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { createEmbeddings } from "@/lib/openai";

// Only action the Inbox exposes: manual assignment to a context, chosen by
// the user themselves. Never wired to any automatic classification — see
// CONTEXT.md "Inbox".
export async function assignToContext(
  _state: string | undefined,
  formData: FormData,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return "Nicht angemeldet";
  }

  const memoryItemId = formData.get("memory_item_id") as string;
  let contextId = String(formData.get("context_id") ?? "");
  const manualContextName = String(
    formData.get("manual_context_name") ?? "",
  ).trim();
  if (!memoryItemId || (!contextId && !manualContextName)) {
    return "Bestehenden Kontext wählen oder neuen Namen eingeben";
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  const { data: memoryItem } = await supabase
    .from("memory_items")
    .select("id, memory_context_links(context_id)")
    .eq("id", memoryItemId)
    .eq("context_space_id", contextSpaceId)
    .maybeSingle();
  if (!memoryItem || memoryItem.memory_context_links.length > 0) {
    return "Eintrag ist nicht mehr in der Inbox";
  }

  if (manualContextName) {
    const { data: existing } = await supabase
      .from("contexts")
      .select("id")
      .eq("context_space_id", contextSpaceId)
      .ilike("name", manualContextName)
      .limit(1)
      .maybeSingle();
    if (existing) {
      contextId = existing.id;
    } else {
      let embedding: number[] | undefined;
      try {
        [embedding] = await createEmbeddings([manualContextName], user.id);
      } catch (error) {
        console.error("Failed to embed manually created context:", error);
      }
      const { data: created, error: createError } = await supabase
        .from("contexts")
        .insert({
          context_space_id: contextSpaceId,
          name: manualContextName,
          embedding,
        })
        .select("id")
        .single();
      if (createError || !created) {
        return createError?.message ?? "Kontext konnte nicht erstellt werden";
      }
      contextId = created.id;
    }
  }

  // Defense in depth: memory_context_links RLS only checks that
  // memory_item_id belongs to a space the caller is a member of, not that
  // context_id belongs to the *same* space as the item — so confirm that
  // here rather than relying on the FK alone.
  const { data: context } = await supabase
    .from("contexts")
    .select("id")
    .eq("id", contextId)
    .eq("context_space_id", contextSpaceId)
    .single();
  if (!context) {
    return "Kontext nicht gefunden";
  }

  const { error } = await supabase.from("memory_context_links").insert({
    memory_item_id: memoryItemId,
    context_id: contextId,
  });

  if (error) {
    return error.message;
  }

  revalidatePath("/inbox");
  revalidatePath("/contexts");
  revalidatePath(`/contexts/${contextId}`);
  return undefined;
}

export async function deleteInboxMemoryItem(
  _state: string | undefined,
  formData: FormData,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "Nicht angemeldet";

  const memoryItemId = String(formData.get("memory_item_id") ?? "");
  if (!memoryItemId) return "Memory-Item fehlt";

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);
  const { data: item, error: itemError } = await supabase
    .from("memory_items")
    .select("id, memory_context_links(context_id)")
    .eq("id", memoryItemId)
    .eq("context_space_id", contextSpaceId)
    .maybeSingle();
  if (itemError) return itemError.message;
  if (!item) return "Memory-Item nicht gefunden";
  if (item.memory_context_links.length > 0) {
    return "Der Eintrag ist nicht mehr in der Inbox";
  }

  const { data: deleted, error: deleteError } = await supabase
    .from("memory_items")
    .delete()
    .eq("id", memoryItemId)
    .eq("context_space_id", contextSpaceId)
    .select("id")
    .maybeSingle();
  if (deleteError) return deleteError.message;
  if (!deleted) return "Memory-Item konnte nicht gelöscht werden";

  revalidatePath("/inbox");
  revalidatePath("/contexts");
  revalidatePath("/search");
  return undefined;
}

const CONFLICT_RESOLUTIONS = [
  "apply_new",
  "keep_existing",
  "keep_both",
] as const;
type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

interface ResolveMemoryConflictRpcResult {
  result_status: "ok" | "error";
  result_message: string | null;
}

// Delegates to the resolve_memory_conflict SQL RPC (supabase/migrations/
// 0015_conflict_review_fixes.sql) rather than doing the multi-step update
// here: it row-locks the review and checks its status inside one
// transaction, so a double-click or two concurrent requests against the
// same review can't both succeed, and a mid-sequence failure can't leave
// memory_items and the review row out of sync — neither of which
// client-side sequential .update() calls could guarantee.
//
// Three resolutions instead of a single confirm/dismiss: a "widerspruch"
// verdict means a human has to decide which side is current, not that the
// new item automatically wins. apply_new supersedes the existing item with
// the new one (the old confirm behavior); keep_existing supersedes the new
// item WITH the existing one (the new statement was the wrong/outdated
// one); keep_both leaves both active (the classifier's guessed relation
// wasn't real).
export async function resolveMemoryConflict(
  _state: string | undefined,
  formData: FormData,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "Nicht angemeldet";

  const reviewId = String(formData.get("review_id") ?? "");
  const resolution = String(formData.get("resolution") ?? "");
  if (!reviewId) return "Konflikt-Eintrag fehlt";
  if (!CONFLICT_RESOLUTIONS.includes(resolution as ConflictResolution)) {
    return "Ungültige Auswahl";
  }

  const { data, error } = await supabase
    .rpc("resolve_memory_conflict", {
      p_review_id: reviewId,
      p_resolution: resolution,
    })
    .single<ResolveMemoryConflictRpcResult>();
  if (error) return error.message;
  if (data?.result_status === "error") {
    return data.result_message ?? "Konflikt konnte nicht aufgelöst werden";
  }

  revalidatePath("/inbox");
  revalidatePath("/contexts");
  revalidatePath("/search");
  return undefined;
}

export async function dismissContextPool(
  _state: string | undefined,
  formData: FormData,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "Nicht angemeldet";

  let memoryItemIds: string[];
  try {
    const value = JSON.parse(String(formData.get("memory_item_ids")));
    memoryItemIds = Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === "string"))]
      : [];
  } catch {
    return "Ungültige Auswahl";
  }
  if (memoryItemIds.length === 0) return "Pool enthält keine Einträge";

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);
  const { data: ownedItems, error: itemError } = await supabase
    .from("memory_items")
    .select("id")
    .eq("context_space_id", contextSpaceId)
    .in("id", memoryItemIds);
  if (itemError) return itemError.message;
  if (ownedItems?.length !== memoryItemIds.length) {
    return "Mindestens ein Eintrag gehört nicht zu deinem Kontext-Space";
  }

  const { error } = await supabase.from("dismissed_context_pool_items").upsert(
    memoryItemIds.map((memoryItemId) => ({
      user_id: user.id,
      memory_item_id: memoryItemId,
    })),
    { onConflict: "user_id,memory_item_id" },
  );
  if (error) return error.message;

  revalidatePath("/inbox");
  return undefined;
}

export async function confirmContextPool(
  _state: string | undefined,
  formData: FormData,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "Nicht angemeldet";

  let memoryItemIds: string[];
  try {
    const value = JSON.parse(String(formData.get("memory_item_ids")));
    memoryItemIds = Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === "string"))]
      : [];
  } catch {
    return "Ungültige Auswahl";
  }
  if (memoryItemIds.length === 0) return "Keine Memory-Items ausgewählt";

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);
  const { data: ownedItems, error: itemError } = await supabase
    .from("memory_items")
    .select("id, memory_context_links(context_id)")
    .eq("context_space_id", contextSpaceId)
    .in("id", memoryItemIds);
  if (itemError) return itemError.message;
  if (
    ownedItems?.length !== memoryItemIds.length ||
    ownedItems.some((item) => item.memory_context_links.length > 0)
  ) {
    return "Mindestens ein Eintrag ist nicht mehr in der Inbox";
  }

  const contextChoice = String(formData.get("context_choice") ?? "");
  let contextId: string;
  if (contextChoice.startsWith("existing:")) {
    contextId = contextChoice.slice("existing:".length);
    const { data: context } = await supabase
      .from("contexts")
      .select("id")
      .eq("id", contextId)
      .eq("context_space_id", contextSpaceId)
      .maybeSingle();
    if (!context) return "Kontext nicht gefunden";
  } else {
    const suggestedName = contextChoice.startsWith("new:")
      ? contextChoice.slice("new:".length)
      : "";
    const manualName = String(formData.get("manual_name") ?? "").trim();
    const name = manualName || suggestedName.trim();
    if (!name) return "Kontextname ist erforderlich";

    const { data: existing } = await supabase
      .from("contexts")
      .select("id")
      .eq("context_space_id", contextSpaceId)
      .ilike("name", name)
      .limit(1)
      .maybeSingle();
    if (existing) {
      contextId = existing.id;
    } else {
      let embedding: number[] | undefined;
      try {
        [embedding] = await createEmbeddings([name], user.id);
      } catch (error) {
        console.error("Failed to embed suggested context:", error);
      }
      const { data: created, error: createError } = await supabase
        .from("contexts")
        .insert({ context_space_id: contextSpaceId, name, embedding })
        .select("id")
        .single();
      if (createError || !created)
        return createError?.message ?? "Kontext konnte nicht erstellt werden";
      contextId = created.id;
    }
  }

  const { error: linkError } = await supabase
    .from("memory_context_links")
    .insert(
      memoryItemIds.map((memoryItemId) => ({
        memory_item_id: memoryItemId,
        context_id: contextId,
      })),
    );
  if (linkError) return linkError.message;

  revalidatePath("/inbox");
  revalidatePath("/contexts");
  revalidatePath(`/contexts/${contextId}`);
  return undefined;
}
