import Link from "next/link";
import { redirect } from "next/navigation";
import { AppNav } from "@/components/app-nav";
import { createClient } from "@/lib/supabase/server";
import {
  REALTIME_MODEL,
  summarizeRealtimeUsage,
  type RealtimeUsageEventRow,
  type RealtimeUsageSummary,
} from "@/lib/realtime-usage";

const PAGE_SIZE = 1000;

function configuredCreditEur(): number {
  const value = Number(process.env.OPENAI_PREPAID_CREDIT_EUR ?? "10");
  return Number.isFinite(value) && value >= 0 ? value : 10;
}

async function loadUsageRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<RealtimeUsageEventRow[]> {
  const rows: RealtimeUsageEventRow[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("dialog_session_events")
      .select("dialog_session_id, created_at, payload")
      .eq("event_type", "response.done")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(error.message);
    const page = (data ?? []) as RealtimeUsageEventRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function formatTokens(value: number): string {
  return value.toLocaleString("de-DE");
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value);
}

function UsageCards({ summary }: { summary: RealtimeUsageSummary }) {
  const cards = [
    {
      label: "Geschätzte Realtime-Kosten",
      value: formatUsd(summary.estimatedCostUsd),
      detail: `${summary.responseCount.toLocaleString("de-DE")} Modell-Antworten`,
      color: "from-violet-600 to-fuchsia-500",
    },
    {
      label: "Tokens gesamt",
      value: formatTokens(summary.totalTokens),
      detail: `${summary.sessionCount.toLocaleString("de-DE")} gespeicherte Sessions`,
      color: "from-cyan-500 to-blue-600",
    },
    {
      label: "Audio-Tokens",
      value: formatTokens(
        summary.inputAudioTokens + summary.outputAudioTokens,
      ),
      detail: `${formatTokens(summary.inputAudioTokens)} rein · ${formatTokens(summary.outputAudioTokens)} raus`,
      color: "from-amber-400 to-orange-500",
    },
  ] as const;

  return (
    <section className="grid gap-4 md:grid-cols-3" aria-label="Verbrauchszusammenfassung">
      {cards.map((card) => (
        <article key={card.label} className="glass-card rounded-3xl p-6">
          <span className={`block h-1.5 w-16 rounded-full bg-gradient-to-r ${card.color}`} />
          <p className="mt-6 text-sm font-medium text-zinc-500 dark:text-zinc-400">
            {card.label}
          </p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white">
            {card.value}
          </p>
          <p className="mt-2 text-xs text-zinc-400">{card.detail}</p>
        </article>
      ))}
    </section>
  );
}

export default async function UsagePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const rows = await loadUsageRows(supabase);
  const summary = summarizeRealtimeUsage(rows);
  const paidCreditEur = configuredCreditEur();

  return (
    <>
      <AppNav current="/usage" />
      <main className="app-page flex flex-1 flex-col gap-8">
        <section>
          <p className="eyebrow">OpenAI Realtime API</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-zinc-950 dark:text-white">
            Verbrauch
          </h1>
          <p className="mt-2 max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-400">
            Tatsächliche Token-Mengen aus deinen gespeicherten Voice-Sessions,
            bewertet mit den aktuellen Preisen von {REALTIME_MODEL}.
          </p>
        </section>

        <UsageCards summary={summary} />

        <section className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
          <article className="glass-card rounded-3xl p-6 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                  Eingezahltes API-Guthaben
                </p>
                <p className="mt-2 text-4xl font-semibold tracking-tight">
                  {paidCreditEur.toLocaleString("de-DE", {
                    style: "currency",
                    currency: "EUR",
                  })}
                </p>
              </div>
              <Link
                href="https://platform.openai.com/settings/organization/billing/credit-grants"
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-700 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                Exaktes Guthaben bei OpenAI ↗
              </Link>
            </div>
            <p className="mt-6 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
              OpenAI veröffentlicht die Modellpreise in US-Dollar. Deshalb
              ziehen wir die lokale USD-Schätzung nicht scheinpräzise von
              deinem Euro-Guthaben ab. Der Link zeigt den verbindlichen
              Kontostand und berücksichtigt auch andere API-Aufrufe.
            </p>
          </article>

          <article className="glass-card rounded-3xl p-6 sm:p-8">
            <h2 className="text-lg font-semibold">Token-Aufteilung</h2>
            <dl className="mt-5 grid grid-cols-[1fr_auto] gap-x-4 gap-y-3 text-sm">
              <dt className="text-zinc-500 dark:text-zinc-400">Text Eingabe</dt>
              <dd className="font-medium">{formatTokens(summary.inputTextTokens)}</dd>
              <dt className="text-zinc-500 dark:text-zinc-400">Audio Eingabe</dt>
              <dd className="font-medium">{formatTokens(summary.inputAudioTokens)}</dd>
              <dt className="text-zinc-500 dark:text-zinc-400">Davon gecacht</dt>
              <dd className="font-medium">{formatTokens(summary.cachedInputTokens)}</dd>
              <dt className="text-zinc-500 dark:text-zinc-400">Text Ausgabe</dt>
              <dd className="font-medium">{formatTokens(summary.outputTextTokens)}</dd>
              <dt className="text-zinc-500 dark:text-zinc-400">Audio Ausgabe</dt>
              <dd className="font-medium">{formatTokens(summary.outputAudioTokens)}</dd>
            </dl>
          </article>
        </section>

        <p className="text-xs leading-5 text-zinc-400">
          Die Schätzung umfasst beendete Voice-Sessions, deren response.done-Events
          gespeichert wurden. Separate Kosten für Embeddings, Websuche,
          Transkription oder andere Modelle sind hier nicht enthalten.
          {summary.firstRecordedAt
            ? ` Aufzeichnung seit ${new Date(summary.firstRecordedAt).toLocaleDateString("de-DE")}.`
            : " Noch keine abgeschlossene Voice-Session mit Usage-Daten gefunden."}
        </p>
      </main>
    </>
  );
}
