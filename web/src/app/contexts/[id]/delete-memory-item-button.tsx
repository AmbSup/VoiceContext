"use client";

import { useState, useTransition } from "react";
import { deleteContextMemoryItem } from "./actions";

export function DeleteMemoryItemButton({
  contextId,
  memoryItemId,
}: {
  contextId: string;
  memoryItemId: string;
}) {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  return (
    <div className="ml-auto flex items-center gap-2">
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
              "Memory-Item endgültig löschen? Ist es mit mehreren Kontexten verknüpft, wird es aus allen entfernt.",
            )
          ) {
            return;
          }
          setError(undefined);
          startTransition(async () => {
            try {
              const result = await deleteContextMemoryItem(
                contextId,
                memoryItemId,
              );
              if (result) setError(result);
            } catch {
              setError("Memory-Item konnte nicht gelöscht werden");
            }
          });
        }}
        title="Memory-Item endgültig löschen"
        aria-label="Memory-Item endgültig löschen"
        className="rounded-full p-1.5 text-zinc-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-950/40 dark:hover:text-red-400"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="h-4 w-4"
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
