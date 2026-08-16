// Summarizes web/src/lib/perf-log.ts's performance_logs rows for the
// /performance page. Two distinct sources land in the same table (see
// mobile/lib/core/data/dialog_session_repository.dart's
// logVoiceTurnLatencies): our own Next.js routes (route names like
// "/api/retrieve") and the mobile client's speech-stopped-to-first-audio
// measurement (route: "voice_turn_latency") — the only latency number that
// covers the WebRTC leg directly between the phone and OpenAI, which never
// touches our backend at all.

export interface PerformanceLogRow {
  route: string;
  total_ms: number;
  phases: Record<string, number>;
  created_at: string;
}

export interface RouteStats {
  route: string;
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgPhases: Record<string, number>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index];
}

export function summarizeByRoute(rows: PerformanceLogRow[]): RouteStats[] {
  const byRoute = new Map<string, PerformanceLogRow[]>();
  for (const row of rows) {
    const list = byRoute.get(row.route) ?? [];
    list.push(row);
    byRoute.set(row.route, list);
  }

  return [...byRoute.entries()]
    .map(([route, routeRows]): RouteStats => {
      const totals = routeRows.map((r) => r.total_ms).sort((a, b) => a - b);
      const sum = totals.reduce((a, b) => a + b, 0);

      const phaseSums: Record<string, number> = {};
      const phaseCounts: Record<string, number> = {};
      for (const row of routeRows) {
        for (const [phase, ms] of Object.entries(row.phases ?? {})) {
          phaseSums[phase] = (phaseSums[phase] ?? 0) + ms;
          phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
        }
      }
      const avgPhases = Object.fromEntries(
        Object.entries(phaseSums).map(([phase, total]) => [
          phase,
          Math.round(total / phaseCounts[phase]),
        ]),
      );

      return {
        route,
        count: routeRows.length,
        avgMs: Math.round(sum / routeRows.length),
        p50Ms: percentile(totals, 50),
        p95Ms: percentile(totals, 95),
        maxMs: totals[totals.length - 1] ?? 0,
        avgPhases,
      };
    })
    .sort((a, b) => b.avgMs - a.avgMs);
}
