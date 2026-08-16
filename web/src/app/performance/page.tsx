import { redirect } from "next/navigation";
import { AppNav } from "@/components/app-nav";
import { createClient } from "@/lib/supabase/server";
import {
  summarizeByRoute,
  type PerformanceLogRow,
  type RouteStats,
} from "@/lib/performance-usage";

const PAGE_SIZE = 1000;
const RECENT_LIMIT = 30;
const VOICE_ROUTE = "voice_turn_latency";

async function loadPerformanceRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<PerformanceLogRow[]> {
  const rows: PerformanceLogRow[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("performance_logs")
      .select("route, total_ms, phases, created_at")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(error.message);
    const page = (data ?? []) as PerformanceLogRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function formatMs(value: number): string {
  return `${value.toLocaleString("de-DE")} ms`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("de-DE", {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

function StatCards({ stats }: { stats: RouteStats[] }) {
  return (
    <section className="grid gap-4 md:grid-cols-3" aria-label="Latenz-Übersicht">
      {stats.map((s) => (
        <article key={s.route} className="glass-card rounded-3xl p-6">
          <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
            {s.route === VOICE_ROUTE ? "Sprach-Antwortzeit" : s.route}
          </p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white">
            {formatMs(s.avgMs)}
          </p>
          <p className="mt-2 text-xs text-zinc-400">
            Ø · p50 {formatMs(s.p50Ms)} · p95 {formatMs(s.p95Ms)} · max{" "}
            {formatMs(s.maxMs)} · {s.count.toLocaleString("de-DE")} Messungen
          </p>
          {Object.keys(s.avgPhases).length > 0 && (
            <dl className="mt-4 space-y-1 border-t border-black/[.06] pt-3 text-xs dark:border-white/[.08]">
              {Object.entries(s.avgPhases)
                .sort((a, b) => b[1] - a[1])
                .map(([phase, ms]) => (
                  <div key={phase} className="flex justify-between gap-3">
                    <dt className="text-zinc-500 dark:text-zinc-400">{phase}</dt>
                    <dd className="font-medium">{formatMs(ms)}</dd>
                  </div>
                ))}
            </dl>
          )}
        </article>
      ))}
    </section>
  );
}

export default async function PerformancePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const rows = await loadPerformanceRows(supabase);
  const stats = summarizeByRoute(rows);
  const voiceStats = stats.find((s) => s.route === VOICE_ROUTE);
  const backendStats = stats.filter((s) => s.route !== VOICE_ROUTE);
  const recent = rows.slice(0, RECENT_LIMIT);

  return (
    <>
      <AppNav current="/performance" />
      <main className="app-page flex flex-1 flex-col gap-8">
        <section>
          <p className="eyebrow">Millisekunden-genau</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-zinc-950 dark:text-white">
            Geschwindigkeit
          </h1>
          <p className="mt-2 max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-400">
            Zwei getrennte Messungen: die Backend-Routen (Token-Minting,
            Retrieval, Kontext-Refresh) laufen auf unserem Server; die
            Sprach-Antwortzeit ist die Zeit vom Ende deines Redebeitrags bis
            zum ersten Ton der Antwort — die läuft komplett direkt zwischen
            Handy und OpenAI über WebRTC und wird von den Backend-Routen
            nicht erfasst.
          </p>
        </section>

        {voiceStats && (
          <section>
            <h2 className="mb-3 text-lg font-semibold">Sprach-Antwortzeit</h2>
            <StatCards stats={[voiceStats]} />
          </section>
        )}

        {backendStats.length > 0 && (
          <section>
            <h2 className="mb-3 text-lg font-semibold">Backend-Routen</h2>
            <StatCards stats={backendStats} />
          </section>
        )}

        <section className="glass-card rounded-3xl p-6 sm:p-8">
          <h2 className="text-lg font-semibold">Letzte Messungen</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-black/[.06] text-xs text-zinc-500 dark:border-white/[.08] dark:text-zinc-400">
                  <th className="py-2 pr-4 font-medium">Zeitpunkt</th>
                  <th className="py-2 pr-4 font-medium">Route</th>
                  <th className="py-2 pr-4 font-medium">Dauer</th>
                  <th className="py-2 font-medium">Phasen</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row, i) => (
                  <tr
                    key={i}
                    className="border-b border-black/[.04] last:border-0 dark:border-white/[.06]"
                  >
                    <td className="py-2 pr-4 whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                      {formatTime(row.created_at)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {row.route === VOICE_ROUTE ? "Sprach-Antwortzeit" : row.route}
                    </td>
                    <td className="py-2 pr-4 font-medium">{formatMs(row.total_ms)}</td>
                    <td className="py-2 text-xs text-zinc-500 dark:text-zinc-400">
                      {Object.entries(row.phases ?? {})
                        .map(([phase, ms]) => `${phase}: ${ms}ms`)
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
                {recent.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-zinc-400">
                      Noch keine Messungen aufgezeichnet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </>
  );
}
