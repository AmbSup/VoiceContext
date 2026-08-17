"use client";

import { useState, useTransition } from "react";
import { deleteEmptyContext } from "./actions";

export function DeleteContextButton({
  contextId,
  contextName,
}: {
  contextId: string;
  contextName: string;
}) {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span className="max-w-48 text-right text-xs text-red-600" role="alert">
          {error}
        </span>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (
            !window.confirm(
              `Leeren Kontext „${contextName}“ endgültig löschen?`,
            )
          ) {
            return;
          }
          setError(undefined);
          startTransition(async () => {
            try {
              const result = await deleteEmptyContext(contextId);
              if (result) setError(result);
            } catch {
              setError("Kontext konnte nicht gelöscht werden");
            }
          });
        }}
        title="Leeren Kontext löschen"
        aria-label={`Leeren Kontext ${contextName} löschen`}
        className="shrink-0 rounded-full p-2 text-zinc-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-950/40 dark:hover:text-red-400"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="h-5 w-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"
          />
        </svg>
      </button>
    </div>
  );
}
