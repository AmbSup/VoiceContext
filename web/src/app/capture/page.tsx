import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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

  return (
    <>
      <AppNav current="/capture" />
      <div className="flex flex-1 flex-col items-center gap-8 bg-zinc-50 px-6 py-12 dark:bg-black">
        <div className="flex w-full max-w-xl flex-col gap-6">
          <div>
            <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
              Erfassen
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Text und Dokumente sind gleichwertige Inputs zum Sprachdialog —
              beide durchlaufen dieselbe Segmentation-/Extraction-Pipeline.
            </p>
          </div>

          <ManualTextForm />
          <DocumentUploadForm />
        </div>
      </div>
    </>
  );
}
