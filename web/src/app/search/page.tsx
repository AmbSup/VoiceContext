import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppNav } from "@/components/app-nav";
import { SearchForm } from "./search-form";

export default async function SearchPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <>
      <AppNav current="/search" />
      <div className="flex flex-1 flex-col items-center gap-8 bg-zinc-50 px-6 py-12 dark:bg-black">
        <div className="w-full max-w-2xl">
          <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
            Suche
          </h1>
          <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
            Stell eine Frage an dein Wissen — die Antwort stützt sich
            ausschließlich auf deine eigenen Memory-Items (kein Internet,
            kein Modellwissen als Quelle).
          </p>
          <SearchForm />
        </div>
      </div>
    </>
  );
}
