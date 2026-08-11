"use client";

import { useActionState, useEffect, useRef } from "react";
import { uploadDocument } from "./actions";
import { CaptureResultMessage } from "./capture-result-message";

export function DocumentUploadForm() {
  const [state, formAction, pending] = useActionState(
    uploadDocument,
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
        Dokument hochladen
      </h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-500">
        Unterstützt: .txt, .md (max. 300 KB).
      </p>
      <input
        type="file"
        name="file"
        required
        accept=".txt,.md,.markdown,text/plain,text/markdown"
        className="text-sm text-black dark:text-zinc-50"
      />
      <div className="flex flex-col gap-1">
        <label
          htmlFor="document-upload-target-context"
          className="text-xs text-zinc-500 dark:text-zinc-500"
        >
          Ziel-Kontext (optional — wird angelegt, falls er noch nicht existiert)
        </label>
        <input
          id="document-upload-target-context"
          type="text"
          name="target_context"
          list="context-names"
          placeholder="z. B. Robotik"
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>
      <CaptureResultMessage state={state} />
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {pending ? "Verarbeite …" : "Hochladen & Verarbeiten"}
      </button>
    </form>
  );
}
