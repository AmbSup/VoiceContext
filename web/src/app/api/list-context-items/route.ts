import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { corsJson, corsPreflight } from "@/lib/cors";

// Structured listing for the Realtime dialog's list_context_items function
// tool (see the `tools` config in api/realtime-token/route.ts) — the
// counterpart to api/retrieve/route.ts's retrieve_memory. That route is
// pure vector similarity search: a query like "list everything in Sport
// Erfolge" has no semantic overlap with the actual fact content (e.g. "Ich
// konnte 100km laufen"), so it finds nothing — confirmed by a user hitting
// exactly that wall. This route instead resolves a spoken context name to
// a contexts row and returns every Memory-Item actually linked to it, no
// similarity ranking involved.
//
// Same cross-origin Bearer-token auth pattern as every other mobile-facing
// route — see api/realtime-token/route.ts for why the token is forwarded
// via `global.headers`, not just passed to auth.getUser().

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(request: Request) {
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

  let contextName: string | undefined;
  try {
    const body = await request.json();
    contextName = (body?.context_name as string | undefined)?.trim();
  } catch {
    return corsJson({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!contextName) {
    return corsJson({ error: "context_name is required" }, { status: 400 });
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  // Partial, case-insensitive match — the model passes whatever name it
  // heard spoken, which won't always be an exact match for how the
  // context was typed originally.
  const { data: matchingContexts, error: contextError } = await supabase
    .from("contexts")
    .select("id, name, description")
    .eq("context_space_id", contextSpaceId)
    .ilike("name", `%${contextName}%`)
    .limit(1);

  if (contextError) {
    return corsJson({ error: contextError.message }, { status: 500 });
  }
  const context = matchingContexts?.[0];
  if (!context) {
    return corsJson({ found: false });
  }

  const { data: items, error: itemsError } = await supabase
    .from("memory_items")
    .select(
      "id, type, content, status, occurred_at, memory_context_links!inner(context_id)",
    )
    .eq("context_space_id", contextSpaceId)
    .eq("memory_context_links.context_id", context.id)
    .order("occurred_at", { ascending: false });

  if (itemsError) {
    return corsJson({ error: itemsError.message }, { status: 500 });
  }

  return corsJson({
    found: true,
    context: { name: context.name, description: context.description },
    items: (items ?? []).map((item) => ({
      type: item.type,
      content: item.content,
      status: item.status,
      occurred_at: item.occurred_at,
    })),
  });
}
