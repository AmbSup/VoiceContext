"use client";

import { useActionState, useEffect, useRef } from "react";
import { submitManualText } from "./actions";
import { CaptureResultMessage } from "./capture-result-message";

export function ManualTextForm() {
  const [state, formAction, pending] = useActionState(
    submitManualText,
    undefined,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.success) {
      formRef.current?.reset();
    }
  }, [state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="flex flex-col gap-3 rounded-lg border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950"
    >
      <h2 className="font-medium text-black dark:text-zinc-50">
        Text eingeben
      </h2>
      <textarea
        name="text"
        required
        rows={8}
        placeholder="Text hier einfügen — durchläuft dieselbe Segmentation-/Extraction-Pipeline wie ein Dialog-Transkript."
        className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black dark:border-white/[.145] dark:text-zinc-50"
      />
      <CaptureResultMessage state={state} />
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {pending ? "Verarbeite …" : "Verarbeiten"}
      </button>
    </form>
  );
}
