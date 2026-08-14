import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { AppNav } from "@/components/app-nav";
import { NewContextForm } from "./new-context-form";
import { setActiveContext } from "./actions";

interface ContextRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  memory_context_links: { count: number }[];
}

export default async function ContextsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  const { data: contexts } = await supabase
    .from("contexts")
    .select("id, name, description, created_at, memory_context_links(count)")
    .eq("context_space_id", contextSpaceId)
    .order("created_at", { ascending: true });
  const { data: activePreference } = await supabase
    .from("active_context_preferences")
    .select("default_context_id")
    .eq("context_space_id", contextSpaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  const activeContextId = activePreference?.default_context_id as
    | string
    | undefined;

  return (
    <>
      <AppNav current="/contexts" />
      <main className="app-page flex flex-1 flex-col items-center">
        <div className="w-full max-w-3xl">
          <p className="eyebrow">Wissensstruktur</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Kontexte
          </h1>
          <p className="mb-8 mt-2 text-base text-zinc-600 dark:text-zinc-400">
            Organisationsknoten innerhalb deiner Context Space (siehe
            CONTEXT.md).
          </p>

          <NewContextForm />

          <ul className="mt-8 flex flex-col gap-3">
            {(contexts ?? []).length === 0 && (
              <li className="text-sm text-zinc-500 dark:text-zinc-500">
                Noch keine Kontexte angelegt.
              </li>
            )}
            {((contexts ?? []) as ContextRow[]).map((context) => {
              const itemCount = context.memory_context_links[0]?.count ?? 0;
              const isActive = context.id === activeContextId;
              return (
                <li
                  key={context.id}
                  className="glass-card flex flex-wrap items-center gap-3 rounded-2xl p-5"
                >
                  <Link
                    href={`/contexts/${context.id}`}
                    className="min-w-0 flex-1 transition duration-200 hover:translate-x-0.5"
                  >
                    <p className="font-semibold text-black dark:text-zinc-50">
                      {context.name}
                    </p>
                    {context.description && (
                      <p className="mt-1 truncate text-sm text-zinc-600 dark:text-zinc-400">
                        {context.description}
                      </p>
                    )}
                  </Link>
                  {isActive ? (
                    <span className="shrink-0 rounded-full bg-emerald-500/10 px-3 py-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                      Aktiver Kontext
                    </span>
                  ) : (
                    <form action={setActiveContext}>
                      <input type="hidden" name="contextId" value={context.id} />
                      <button
                        type="submit"
                        className="shrink-0 rounded-full border border-violet-300 px-3 py-1.5 text-sm font-semibold text-violet-700 hover:bg-violet-500/10 dark:border-violet-700 dark:text-violet-300"
                      >
                        Als Standard wählen
                      </button>
                    </form>
                  )}
                  <span className="shrink-0 rounded-full bg-violet-500/10 px-3 py-1.5 text-sm font-semibold text-violet-700 dark:text-violet-300">
                    {itemCount.toLocaleString("de-DE")} {itemCount === 1 ? "Item" : "Items"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </main>
    </>
  );
}
