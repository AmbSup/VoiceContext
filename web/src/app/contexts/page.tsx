import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { AppNav } from "@/components/app-nav";
import { NewContextForm } from "./new-context-form";

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
    .select("id, name, description, created_at")
    .eq("context_space_id", contextSpaceId)
    .order("created_at", { ascending: true });

  return (
    <>
      <AppNav current="/contexts" />
      <div className="flex flex-1 flex-col items-center gap-8 bg-zinc-50 px-6 py-12 dark:bg-black">
        <div className="w-full max-w-xl">
          <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
            Kontexte
          </h1>
          <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
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
            {(contexts ?? []).map((context) => (
              <li key={context.id}>
                <Link
                  href={`/contexts/${context.id}`}
                  className="block rounded-lg border border-black/[.08] bg-white p-4 transition-colors hover:bg-zinc-50 dark:border-white/[.145] dark:bg-zinc-950 dark:hover:bg-zinc-900"
                >
                  <p className="font-medium text-black dark:text-zinc-50">
                    {context.name}
                  </p>
                  {context.description && (
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                      {context.description}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
