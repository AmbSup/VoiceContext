import Link from "next/link";

const LINKS = [
  { href: "/", label: "Übersicht", icon: "⌂" },
  { href: "/contexts", label: "Kontexte", icon: "◫" },
  { href: "/capture", label: "Erfassen", icon: "+" },
  { href: "/inbox", label: "Inbox", icon: "↓" },
  { href: "/search", label: "Suche", icon: "⌕" },
  { href: "/usage", label: "Verbrauch", icon: "€" },
] as const;

export function AppNav({ current }: { current: (typeof LINKS)[number]["href"] }) {
  return (
    <header className="sticky top-0 z-30 border-b border-black/[.06] bg-white/75 backdrop-blur-xl dark:border-white/[.08] dark:bg-[#0b0d14]/75">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-6 px-4 py-3 sm:px-6">
        <Link href="/" className="mr-auto flex items-center gap-3" aria-label="Voice Context Startseite">
          <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-violet-600 to-cyan-500 text-sm font-bold text-white shadow-lg shadow-violet-500/20">VC</span>
          <span className="hidden text-sm font-semibold tracking-tight sm:block">Voice Context</span>
        </Link>
        <nav className="flex items-center gap-1 overflow-x-auto" aria-label="Hauptnavigation">
          {LINKS.map((link) => {
            const active = link.href === current;
            return (
              <Link key={link.href} href={link.href} aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition ${active ? "bg-violet-600 text-white shadow-md shadow-violet-500/20" : "text-zinc-500 hover:bg-black/[.04] hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-white/[.06] dark:hover:text-white"}`}>
                <span aria-hidden="true" className="text-base leading-none">{link.icon}</span>
                <span className="hidden md:inline">{link.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
