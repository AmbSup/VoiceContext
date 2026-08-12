import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";
import { AppNav } from "@/components/app-nav";
import { ManualTextForm } from "./manual-text-form";
import { DocumentUploadForm } from "./document-upload-form";

export default async function CapturePage() {
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
    .select("name")
    .eq("context_space_id", contextSpaceId)
    .order("name", { ascending: true });
  const contextNames = (contexts ?? []).map((c) => c.name as string);

  return (
    <>
      <AppNav current="/capture" />
      <main className="app-page flex flex-1 flex-col items-center">
        <div className="flex w-full max-w-3xl flex-col gap-6">
          <div>
            <p className="eyebrow">Neuer Inhalt</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-black dark:text-zinc-50">
              Erfassen
            </h1>
            <p className="mt-2 text-base text-zinc-600 dark:text-zinc-400">
              Text und Dokumente sind gleichwertige Inputs zum Sprachdialog —
              beide durchlaufen dieselbe Segmentation-/Extraction-Pipeline.
            </p>
          </div>

          {/* Shared by both forms' "Ziel-Kontext"-Feld (list=context-names) —
              autocomplete suggestions only, the field stays free text. */}
          <datalist id="context-names">
            {contextNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>

          <ManualTextForm />
          <DocumentUploadForm />
        </div>
      </main>
    </>
  );
}
