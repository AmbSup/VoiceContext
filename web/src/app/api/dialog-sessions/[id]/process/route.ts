import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { runSegmentationPipeline } from "@/lib/pipeline";
import { corsJson, corsPreflight } from "@/lib/cors";
import {
  createSessionMemoryNote,
  sessionMemoryTokenCount,
} from "@/lib/short-term-memory";

// Triggers the shared Segmentation/Extraction/Classification pipeline (see
// src/lib/pipeline.ts) for a finished Dialog-Session (see
// docs/implementation-plan.md Phase 2, steps 4-6, and ADR 0002). Runs once
// per dialog_sessions row, triggered by the mobile app right after it
// persists ended_at/full_transcript (see
// mobile/lib/core/api/dialog_processing_client.dart). Never runs live —
// Memory Extraction stays deliberately deferred so the Realtime dialog
// itself is unaffected (CONTEXT.md "Dialogzustand").
//
// This route's own job is just the dialog_sessions-specific status
// bookkeeping (processing_status/processed_at/processing_error) around
// that shared pipeline call.
//
// Auth follows the same cross-origin pattern as
// web/src/app/api/realtime-token/route.ts: the mobile client forwards its
// own Supabase access token, and all reads/writes below run through that
// same anon-key client so RLS enforces context_space membership naturally
// — no service-role client involved.

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

  // Passing the user's JWT as the client's Authorization header (not just
  // to auth.getUser() below) is what makes the .from() calls further down
  // run as the `authenticated` role under RLS — auth.getUser(accessToken)
  // only verifies the token, it doesn't attach it to the client's own
  // outgoing requests.
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

  const { id: dialogSessionId } = await params;

  const { data: session } = await supabase
    .from("dialog_sessions")
    .select(
      "id, context_space_id, started_context_id, ended_at, full_transcript, processing_status",
    )
    .eq("id", dialogSessionId)
    .single();

  // RLS already scopes this to rows the caller's context_space membership
  // covers, so a missing row means "not found or not yours" — either way
  // there's nothing more to say than 404.
  if (!session) {
    return corsJson({ error: "Dialog session not found" }, { status: 404 });
  }
  if (!session.ended_at) {
    return corsJson(
      { error: "Dialog session has not ended yet" },
      { status: 409 },
    );
  }
  if (session.processing_status === "fertig") {
    return corsJson({ status: "already_processed" });
  }
  if (session.processing_status === "laeuft") {
    return corsJson(
      { error: "Dialog session is already being processed" },
      { status: 409 },
    );
  }

  // Closes the race window before the (slow) OpenAI call so a concurrent
  // call to this route sees 'laeuft' instead of racing the same session.
  await supabase
    .from("dialog_sessions")
    .update({ processing_status: "laeuft" })
    .eq("id", dialogSessionId);

  try {
    const transcript = session.full_transcript ?? "";
    const [pipelineOutcome, noteOutcome] = await Promise.allSettled([
      runSegmentationPipeline({
        supabase,
        contextSpaceId: session.context_space_id as string,
        createdBy: user.id,
        safetyIdentifier: user.id,
        sourceType: "voice",
        dialogSessionId,
        transcript,
        targetContextId:
          (session.started_context_id as string | null) ?? undefined,
      }),
      createSessionMemoryNote(transcript, user.id),
    ]);

    if (noteOutcome.status === "fulfilled" && noteOutcome.value) {
      const note = noteOutcome.value;
      const { error: noteError } = await supabase
        .from("dialog_sessions")
        .update({
          short_term_memory: note,
          short_term_memory_token_count: sessionMemoryTokenCount(note),
          short_term_memory_generated_at: new Date().toISOString(),
        })
        .eq("id", dialogSessionId);
      if (noteError) {
        console.error(
          `Failed to store short-term memory for session ${dialogSessionId}:`,
          noteError.message,
        );
      }
    } else if (noteOutcome.status === "rejected") {
      // The next session can still use the persisted raw final turns. A note
      // failure must not discard otherwise successful long-term extraction.
      console.error(
        `Failed to create short-term memory for session ${dialogSessionId}:`,
        noteOutcome.reason,
      );
    }

    if (pipelineOutcome.status === "rejected") throw pipelineOutcome.reason;
    const result = pipelineOutcome.value;

    await supabase
      .from("dialog_sessions")
      .update({ processing_status: "fertig", processed_at: new Date().toISOString() })
      .eq("id", dialogSessionId);

    return corsJson(result);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await supabase
      .from("dialog_sessions")
      .update({
        processing_status: "fehlgeschlagen",
        processing_error: detail.slice(0, 2000),
      })
      .eq("id", dialogSessionId);
    return corsJson(
      { error: "Failed to process dialog session", detail },
      { status: 502 },
    );
  }
}
