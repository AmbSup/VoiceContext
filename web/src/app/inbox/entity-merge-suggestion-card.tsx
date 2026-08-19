"use client";

import { useActionState } from "react";
import { resolveEntityMergeSuggestion } from "./actions";
import { formatEntityType } from "@/lib/entities";

interface SuggestionEntity {
  name: string;
  type: string;
}

export function EntityMergeSuggestionCard({
  suggestionId,
  similarity,
  sourceEntity,
  targetEntity,
}: {
  suggestionId: string;
  similarity: number;
  sourceEntity: SuggestionEntity;
  targetEntity: SuggestionEntity;
}) {
  const [error, action, pending] = useActionState(
    resolveEntityMergeSuggestion,
    undefined,
  );

  return (
    <li className="glass-card rounded-2xl p-5">
      <div className="flex items-start justify-between gap-4">
        <span className="rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-sky-700 dark:bg-sky-950 dark:text-sky-300">
          Mögliche gleiche Entität
        </span>
        <span className="text-xs text-zinc-500">
          {Math.round(similarity * 100)}% Ähnlichkeit
        </span>
      </div>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Neu erfasst
          </p>
          <p className="mt-1 text-sm text-black dark:text-zinc-50">
            {sourceEntity.name}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {formatEntityType(sourceEntity.type)}
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Bestehend
          </p>
          <p className="mt-1 text-sm text-black dark:text-zinc-50">
            {targetEntity.name}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {formatEntityType(targetEntity.type)}
          </p>
        </div>
      </div>
      <form action={action} className="mt-4 flex flex-wrap items-center gap-2">
        <input type="hidden" name="suggestion_id" value={suggestionId} />
        <button
          type="submit"
          name="resolution"
          value="merge"
          disabled={pending}
          className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          Zusammenführen
        </button>
        <button
          type="submit"
          name="resolution"
          value="keep_separate"
          disabled={pending}
          className="rounded-full border border-black/[.08] px-4 py-2 text-sm font-medium transition hover:bg-zinc-50 disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-zinc-900"
        >
          Getrennt lassen
        </button>
      </form>
      {pending && (
        <p
          className="mt-2 text-sm text-zinc-500"
          role="status"
          aria-live="polite"
        >
          Entscheidung wird gespeichert …
        </p>
      )}
      {error && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
