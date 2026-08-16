import type { SupabaseClient } from "@supabase/supabase-js";

// Millisecond-precision timing for the backend routes on the live-dialog
// latency path (retrieve_memory, realtime-token minting, the live
// context-instructions refresh) — persisted so "is X slow" has real
// numbers behind it instead of a guess. Each route creates one PerfTimer,
// calls .mark(label) between phases, and awaits logPerf() once at the end
// with the accumulated phase breakdown.
//
// Awaited, not fire-and-forget: a Next.js serverless function can be torn
// down as soon as its response is sent, so an un-awaited insert() risks
// never completing. A single small insert costs a few ms — acceptable for
// a diagnostic feature, and total_ms is still captured *before* that insert
// runs (see PerfTimer.totalMs below), so the log write's own latency never
// pollutes the number being logged.

export class PerfTimer {
  private readonly start = performance.now();
  private lastMark = this.start;
  private readonly phases: Record<string, number> = {};

  /** Records elapsed ms since the previous mark() (or since construction). */
  mark(label: string): void {
    const now = performance.now();
    this.phases[label] = Math.round(now - this.lastMark);
    this.lastMark = now;
  }

  totalMs(): number {
    return Math.round(performance.now() - this.start);
  }

  phasesSnapshot(): Record<string, number> {
    return { ...this.phases };
  }
}

export async function logPerf(
  supabase: SupabaseClient,
  params: {
    route: string;
    timer: PerfTimer;
    contextSpaceId?: string;
    dialogSessionId?: string;
  },
): Promise<void> {
  const { route, timer, contextSpaceId, dialogSessionId } = params;
  const { error } = await supabase.from("performance_logs").insert({
    route,
    total_ms: timer.totalMs(),
    phases: timer.phasesSnapshot(),
    context_space_id: contextSpaceId ?? null,
    dialog_session_id: dialogSessionId ?? null,
  });
  // A logging failure must never surface as a request failure — this is
  // diagnostic-only, never the source of truth for whether a route worked.
  if (error) {
    console.error(`Failed to log performance for ${route}:`, error.message);
  }
}
