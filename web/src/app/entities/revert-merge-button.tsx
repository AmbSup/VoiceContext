"use client";

import { useState, useTransition } from "react";
import { revertEntityMerge } from "./actions";

export function RevertMergeButton({
  mergeId,
  sourceName,
  targetName,
}: {
  mergeId: string;
  sourceName: string;
  targetName: string;
}) {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span className="text-xs text-red-600" role="alert">
          {error}
        </span>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (
            !window.confirm(
              `„${sourceName}“ wieder von „${targetName}“ trennen?`,
            )
          ) {
            return;
          }
          setError(undefined);
          startTransition(async () => {
            try {
              const result = await revertEntityMerge(mergeId);
              if (result) setError(result);
            } catch {
              setError("Konnte nicht rückgängig gemacht werden");
            }
          });
        }}
        className="shrink-0 rounded-full border border-black/[.08] px-3 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50 disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-400 dark:hover:bg-zinc-900"
      >
        Rückgängig
      </button>
    </div>
  );
}
