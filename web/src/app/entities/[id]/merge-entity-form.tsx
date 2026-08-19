"use client";

import { useState, useTransition } from "react";
import { mergeEntity } from "./actions";

export function MergeEntityForm({
  entityId,
  entityName,
  candidates,
}: {
  entityId: string;
  entityName: string;
  candidates: { id: string; name: string }[];
}) {
  const [target, setTarget] = useState(candidates[0]?.id ?? "");
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-500">
        Keine anderen Entitäten desselben Typs vorhanden.
      </p>
    );
  }

  const targetName = candidates.find((c) => c.id === target)?.name ?? "";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={target}
        onChange={(event) => setTarget(event.target.value)}
        className="rounded border border-black/[.08] bg-transparent px-3 py-1.5 text-sm text-black dark:border-white/[.145] dark:text-zinc-50"
      >
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={pending || !target}
        onClick={() => {
          if (
            !window.confirm(
              `„${entityName}“ in „${targetName}“ zusammenführen? Lässt sich später wieder rückgängig machen.`,
            )
          ) {
            return;
          }
          setError(undefined);
          startTransition(async () => {
            const result = await mergeEntity(entityId, target);
            if (result) setError(result);
          });
        }}
        className="rounded-full border border-black/[.08] px-3 py-1.5 text-sm font-medium transition hover:bg-zinc-50 disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-zinc-900"
      >
        {pending ? "Führe zusammen …" : "Zusammenführen"}
      </button>
      {error && (
        <p className="w-full text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
