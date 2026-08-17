"use client";

import { useState, useTransition } from "react";
import {
  formatMemoryItemConfidence,
  formatMemoryItemStatus,
  formatMemoryItemType,
  memoryItemStatusClasses,
} from "@/lib/memory-items";
import { deleteContextMemoryItems } from "./actions";
import { DeleteMemoryItemButton } from "./delete-memory-item-button";

export interface ContextMemoryItem {
  id: string;
  type: string;
  content: string;
  status: string;
  confidence: string | null;
  occurred_at: string;
}

export function MemoryItemList({
  contextId,
  items,
}: {
  contextId: string;
  items: ContextMemoryItem[];
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const availableIds = new Set(items.map((item) => item.id));
  const selectedVisibleIds = [...selectedIds].filter((id) =>
    availableIds.has(id),
  );
  const allSelected =
    items.length > 0 && selectedVisibleIds.length === items.length;

  return (
    <>
      {items.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-black/[.08] bg-white px-4 py-3 dark:border-white/[.145] dark:bg-zinc-950">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(event) => {
                setSelectedIds(
                  event.target.checked
                    ? new Set(items.map((item) => item.id))
                    : new Set(),
                );
                setError(undefined);
              }}
              className="h-4 w-4 rounded border-zinc-300 accent-black dark:accent-white"
            />
            Alle auswählen
          </label>
          <button
            type="button"
            disabled={pending || selectedVisibleIds.length === 0}
            onClick={() => {
              const count = selectedVisibleIds.length;
              if (
                !window.confirm(
                  `${count} Memory-${count === 1 ? "Item" : "Items"} endgültig löschen? Mehrfach verknüpfte Items werden aus allen Kontexten entfernt.`,
                )
              ) {
                return;
              }
              setError(undefined);
              startTransition(async () => {
                try {
                  const result = await deleteContextMemoryItems(
                    contextId,
                    selectedVisibleIds,
                  );
                  if (result) {
                    setError(result);
                  } else {
                    setSelectedIds(new Set());
                  }
                } catch {
                  setError("Memory-Items konnten nicht gelöscht werden");
                }
              });
            }}
            className="ml-auto rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending
              ? "Wird gelöscht …"
              : `Ausgewählte löschen${selectedVisibleIds.length > 0 ? ` (${selectedVisibleIds.length})` : ""}`}
          </button>
          {error && (
            <p className="w-full text-xs text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      <ul className="flex flex-col gap-3">
        {items.length === 0 && (
          <li className="text-sm text-zinc-500 dark:text-zinc-500">
            Noch keine Memory-Items in diesem Kontext.
          </li>
        )}
        {items.map((item) => {
          const confidenceLabel = formatMemoryItemConfidence(item.confidence);
          return (
            <li
              key={item.id}
              className="rounded-lg border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950"
            >
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.id)}
                  onChange={(event) => {
                    setSelectedIds((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(item.id);
                      else next.delete(item.id);
                      return next;
                    });
                    setError(undefined);
                  }}
                  aria-label={`Memory-Item auswählen: ${item.content}`}
                  className="mr-1 h-4 w-4 shrink-0 rounded border-zinc-300 accent-black dark:accent-white"
                />
                <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {formatMemoryItemType(item.type)}
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${memoryItemStatusClasses(item.status)}`}
                >
                  {formatMemoryItemStatus(item.status)}
                </span>
                {confidenceLabel && (
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">
                    {confidenceLabel}
                  </span>
                )}
                <span className="ml-auto text-xs text-zinc-400 dark:text-zinc-500">
                  {new Date(item.occurred_at).toLocaleString("de-DE")}
                </span>
                <DeleteMemoryItemButton
                  contextId={contextId}
                  memoryItemId={item.id}
                />
              </div>
              <p className="mt-2 text-sm text-black dark:text-zinc-50">
                {item.content}
              </p>
            </li>
          );
        })}
      </ul>
    </>
  );
}
