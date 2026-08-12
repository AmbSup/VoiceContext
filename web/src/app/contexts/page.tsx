import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { AppNav } from "@/components/app-nav";
import { NewContextForm } from "./new-context-form";

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
              return (
              <li key={context.id}>
                <Link
                  href={`/contexts/${context.id}`}
                  className="glass-card flex items-center justify-between gap-4 rounded-2xl p-5 transition duration-200 hover:-translate-y-0.5"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-black dark:text-zinc-50">
                      {context.name}
                    </p>
                    {context.description && (
                      <p className="mt-1 truncate text-sm text-zinc-600 dark:text-zinc-400">
                        {context.description}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 rounded-full bg-violet-500/10 px-3 py-1.5 text-sm font-semibold text-violet-700 dark:text-violet-300">
                    {itemCount.toLocaleString("de-DE")} {itemCount === 1 ? "Item" : "Items"}
                  </span>
                </Link>
              </li>
              );
            })}
          </ul>
        </div>
      </main>
    </>
  );
}
