import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { corsJson, corsPreflight } from "@/lib/cors";

// Ergebnisse screen's one "primary action": marking a user-directed
// aufgabe/offene_frage/termin as done. Deliberately narrow — this is not a
// general status editor, just the one transition that reuses the
// already-defined-but-previously-unused status='erledigt' value (see
// supabase/migrations/0001_init_schema.sql). No other transition, no
// email/notification side effect.

const ELIGIBLE_TYPES = ["aufgabe", "offene_frage", "termin"];

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const accessToken = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    return corsJson({ error: "Not authenticated" }, { status: 401 });
  }

  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } },
  );
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(accessToken);
  if (authError || !user) {
    return corsJson({ error: "Not authenticated" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return corsJson({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.status !== "erledigt") {
    return corsJson(
      { error: 'Only {"status": "erledigt"} is supported' },
      { status: 400 },
    );
  }

  const { id: memoryItemId } = await params;

  const { data: item } = await supabase
    .from("memory_items")
    .select("id, type, status")
    .eq("id", memoryItemId)
    .single();

  // RLS already scopes this to rows the caller's context_space membership
  // covers, so a missing row means "not found or not yours" — either way
  // there's nothing more to say than 404.
  if (!item) {
    return corsJson({ error: "Memory item not found" }, { status: 404 });
  }
  if (!ELIGIBLE_TYPES.includes(item.type as string)) {
    return corsJson(
      { error: `Type "${item.type}" does not support this action` },
      { status: 400 },
    );
  }
  if (item.status !== "aktiv") {
    return corsJson(
      { error: `Item is already "${item.status}"` },
      { status: 409 },
    );
  }

  const { error: updateError } = await supabase
    .from("memory_items")
    .update({ status: "erledigt", updated_at: new Date().toISOString() })
    .eq("id", memoryItemId);
  if (updateError) throw updateError;

  return corsJson({ id: memoryItemId, status: "erledigt" });
}
