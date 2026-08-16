import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { corsJson, corsPreflight } from "@/lib/cors";

const KINDS = new Set(["email", "aufgabe", "frage"]);

function textValue(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : null;
}

async function authenticatedClient(request: Request) {
  const accessToken = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  if (!accessToken) return null;

  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } },
  );
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(accessToken);
  return error || !user ? null : { supabase, user };
}

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: Request) {
  const auth = await authenticatedClient(request);
  if (!auth) return corsJson({ error: "Not authenticated" }, { status: 401 });

  const dialogSessionId = new URL(request.url).searchParams.get(
    "dialog_session_id",
  );
  let query = auth.supabase
    .from("saved_results")
    .select(
      "id, kind, title, content, recipient, due_at, status, created_at, dialog_session_id, context_id, contexts(name), dialog_sessions(started_at)",
    )
    .eq("created_by", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (dialogSessionId) query = query.eq("dialog_session_id", dialogSessionId);

  const { data, error } = await query;
  if (error) return corsJson({ error: error.message }, { status: 500 });

  return corsJson({
    items: (data ?? []).map((row) => {
      const context = Array.isArray(row.contexts) ? row.contexts[0] : row.contexts;
      const session = Array.isArray(row.dialog_sessions)
        ? row.dialog_sessions[0]
        : row.dialog_sessions;
      return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        content: row.content,
        recipient: row.recipient,
        dueAt: row.due_at,
        status: row.status,
        createdAt: row.created_at,
        dialogSessionId: row.dialog_session_id,
        contextId: row.context_id,
        contextName: context?.name ?? null,
        sessionStartedAt: session?.started_at ?? null,
      };
    }),
  });
}

export async function POST(request: Request) {
  const auth = await authenticatedClient(request);
  if (!auth) return corsJson({ error: "Not authenticated" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return corsJson({ error: "Invalid JSON body" }, { status: 400 });
  }

  const dialogSessionId = textValue(body.dialogSessionId, 64);
  const kind = textValue(body.kind, 20);
  const title = textValue(body.title, 200);
  const content = textValue(body.content, 10000);
  if (!dialogSessionId || !kind || !KINDS.has(kind) || !title || !content) {
    return corsJson(
      { error: "dialogSessionId, kind, title and content are required" },
      { status: 400 },
    );
  }

  const { data: session, error: sessionError } = await auth.supabase
    .from("dialog_sessions")
    .select("id, context_space_id, started_context_id, user_id")
    .eq("id", dialogSessionId)
    .eq("user_id", auth.user.id)
    .single();
  if (sessionError || !session) {
    return corsJson({ error: "Dialog session not found" }, { status: 404 });
  }

  let contextId = textValue(body.contextId, 64) ?? session.started_context_id;
  if (contextId) {
    const { data: context } = await auth.supabase
      .from("contexts")
      .select("id")
      .eq("id", contextId)
      .eq("context_space_id", session.context_space_id)
      .maybeSingle();
    if (!context) contextId = session.started_context_id;
  }

  const recipient = textValue(body.recipient, 320);
  const dueAt = textValue(body.dueAt, 64);
  if (dueAt && Number.isNaN(Date.parse(dueAt))) {
    return corsJson({ error: "dueAt must be an ISO date" }, { status: 400 });
  }

  const { data, error } = await auth.supabase
    .from("saved_results")
    .insert({
      context_space_id: session.context_space_id,
      created_by: auth.user.id,
      dialog_session_id: session.id,
      context_id: contextId,
      kind,
      title,
      content,
      recipient,
      due_at: dueAt,
      status: kind === "email" ? "entwurf" : "offen",
    })
    .select("id, kind, title, content, recipient, due_at, status, created_at")
    .single();
  if (error) return corsJson({ error: error.message }, { status: 500 });

  return corsJson(
    {
      item: {
        id: data.id,
        kind: data.kind,
        title: data.title,
        content: data.content,
        recipient: data.recipient,
        dueAt: data.due_at,
        status: data.status,
        createdAt: data.created_at,
      },
    },
    { status: 201 },
  );
}
