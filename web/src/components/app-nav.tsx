import Link from "next/link";

const LINKS = [
  { href: "/", label: "Start" },
  { href: "/contexts", label: "Kontexte" },
  { href: "/inbox", label: "Inbox" },
] as const;

export function AppNav({ current }: { current: (typeof LINKS)[number]["href"] }) {
  return (
    <nav className="flex gap-5 border-b border-black/[.08] bg-white px-6 py-3 dark:border-white/[.145] dark:bg-zinc-950">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={
            link.href === current
              ? "text-sm font-medium text-black dark:text-zinc-50"
              : "text-sm text-zinc-500 transition-colors hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
          }
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
