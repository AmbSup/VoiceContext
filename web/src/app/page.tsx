import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { AppNav } from "@/components/app-nav";
import { logout } from "./logout/actions";

const actions = [
  { href: "/capture", title: "Gedanken erfassen", text: "Notiz oder Dokument in deinen Wissensraum legen.", mark: "+", color: "from-violet-600 to-fuchsia-500" },
  { href: "/search", title: "Wissen befragen", text: "Antworten aus deinen gespeicherten Erinnerungen erhalten.", mark: "⌕", color: "from-cyan-500 to-blue-600" },
  { href: "/inbox", title: "Inbox ordnen", text: "Neue Inhalte prüfen und dem richtigen Kontext zuweisen.", mark: "↓", color: "from-amber-400 to-orange-500" },
] as const;

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const name = user?.email?.split("@")[0] ?? "du";

  return (
    <>
      <AppNav current="/" />
      <main className="app-page flex flex-1 flex-col gap-10">
        <section className="grid items-center gap-10 lg:grid-cols-[1.15fr_.85fr]">
          <div>
            <p className="eyebrow">Dein persönlicher Wissensraum</p>
            <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-[-.045em] text-zinc-950 sm:text-6xl dark:text-white">
              Guten Tag, <span className="bg-gradient-to-r from-violet-600 to-cyan-500 bg-clip-text text-transparent">{name}</span>.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-8 text-zinc-600 dark:text-zinc-400">
              Was möchtest du heute festhalten, ordnen oder wiederfinden?
            </p>
          </div>
          <div className="orb-float mx-auto grid size-52 place-items-center rounded-full bg-gradient-to-br from-violet-600/15 to-cyan-400/20 shadow-[0_30px_90px_rgba(101,88,232,.2)]">
            <div className="orb-spin size-36 rounded-[44%_56%_57%_43%/42%_45%_55%_58%] bg-[conic-gradient(from_90deg,#6558e8,#20c5d8,#e14fbc,#6558e8)] shadow-[inset_0_0_25px_rgba(255,255,255,.35),0_20px_50px_rgba(101,88,232,.28)]" />
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          {actions.map((action) => (
            <Link key={action.href} href={action.href} className="glass-card group rounded-3xl p-6 transition duration-300 hover:-translate-y-1 hover:shadow-[0_24px_70px_rgba(29,39,68,.13)]">
              <span className={`grid size-11 place-items-center rounded-2xl bg-gradient-to-br ${action.color} text-xl text-white shadow-lg`}>{action.mark}</span>
              <h2 className="mt-8 text-lg font-semibold tracking-tight">{action.title}</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{action.text}</p>
              <span className="mt-5 inline-block text-sm font-semibold text-violet-600 transition-transform group-hover:translate-x-1 dark:text-violet-400">Öffnen →</span>
            </Link>
          ))}
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-black/[.07] pt-6 text-xs text-zinc-400 dark:border-white/[.08]">
          <span>Angemeldet als {user?.email}</span>
          <form action={logout}><button type="submit" className="rounded-lg px-3 py-2 font-medium text-zinc-500 transition hover:bg-black/[.04] hover:text-zinc-900 dark:hover:bg-white/[.06] dark:hover:text-white">Abmelden</button></form>
        </footer>
      </main>
    </>
  );
}
