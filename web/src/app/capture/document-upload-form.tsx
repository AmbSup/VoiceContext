"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { uploadDocument } from "./actions";
import { CaptureResultMessage } from "./capture-result-message";

export function DocumentUploadForm() {
  const [state, formAction, pending] = useActionState(
    uploadDocument,
    undefined,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [fileInfo, setFileInfo] = useState<string>();

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
        Text/Markdown bis 1 MB · PDF/Word bis 4 MB. Große Dokumente werden
        automatisch abschnittsweise verarbeitet.
      </p>
      <input
        type="file"
        name="file"
        required
        accept=".txt,.md,.markdown,.pdf,.doc,.docx,text/plain,text/markdown,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) {
            setFileInfo(undefined);
            return;
          }
          const extension = file.name
            .slice(file.name.lastIndexOf("."))
            .toLowerCase();
          const maxMb = [".txt", ".md", ".markdown"].includes(extension)
            ? 1
            : 4;
          const actualMb = file.size / (1024 * 1024);
          setFileInfo(
            `${actualMb.toFixed(actualMb < 1 ? 2 : 1)} MB von maximal ${maxMb} MB`,
          );
        }}
        className="text-sm text-black dark:text-zinc-50"
      />
      {fileInfo && !state?.success && (
        <p className="text-xs font-medium text-violet-600 dark:text-violet-400">
          {fileInfo}
        </p>
      )}
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
