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
      <main className="app-page flex flex-1 flex-col items-center">
        <div className="w-full max-w-3xl">
          <p className="eyebrow">Dein Gedächtnis</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Suche
          </h1>
          <p className="mb-8 mt-2 text-base text-zinc-600 dark:text-zinc-400">
            Stell eine Frage an dein Wissen — die Antwort stützt sich
            ausschließlich auf deine eigenen Memory-Items (kein Internet,
            kein Modellwissen als Quelle).
          </p>
          <SearchForm />
        </div>
      </main>
    </>
  );
}
