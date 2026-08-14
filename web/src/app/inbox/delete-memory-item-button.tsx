"use client";

import { useRef, useState, useTransition } from "react";
import { deleteInboxMemoryItem } from "./actions";

export function DeleteMemoryItemButton({
  memoryItemId,
}: {
  memoryItemId: string;
}) {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const cardRef = useRef<HTMLElement | null>(null);

  return (
    <div className="ml-1 flex items-center">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(undefined);
          const card = document
            .querySelector(`[data-memory-item-id="${memoryItemId}"]`)
            ?.closest("li") as HTMLElement | null;
          cardRef.current = card;
          if (card) card.hidden = true;
          startTransition(async () => {
            try {
              const formData = new FormData();
              formData.set("memory_item_id", memoryItemId);
              const result = await deleteInboxMemoryItem(undefined, formData);
              if (result) {
                setError(result);
                if (cardRef.current) cardRef.current.hidden = false;
              }
            } catch {
              setError("Memory-Item konnte nicht gelöscht werden");
              if (cardRef.current) cardRef.current.hidden = false;
            }
          });
        }}
        data-memory-item-id={memoryItemId}
        title="Memory-Eintrag löschen"
        aria-label="Memory-Eintrag löschen"
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
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" />
        </svg>
      </button>
      {error && (
        <span className="ml-2 text-xs text-red-600" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
