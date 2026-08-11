import { createClient } from "@/lib/supabase/server";
import { AppNav } from "@/components/app-nav";
import { logout } from "./logout/actions";

// Auth is protected by src/proxy.ts (unauthenticated requests are
// redirected to /login before this component ever renders), so this
// page can assume `user` is set.
export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <>
      <AppNav current="/" />
      <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-zinc-50 dark:bg-black">
        <p className="text-black dark:text-zinc-50">
          Angemeldet als {user?.email}
        </p>
        <form action={logout}>
          <button
            type="submit"
            className="rounded-full border border-black/[.08] px-5 py-2 text-sm font-medium text-black transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-[#1a1a1a]"
          >
            Abmelden
          </button>
        </form>
      </div>
    </>
  );
}
