"use client";

import { useActionState, useState } from "react";
import { confirmContextPool } from "./actions";

interface ContextOption { id: string; name: string }

export function ContextPoolForm({
  itemIds,
  title,
  recommendedContextId,
  alternatives,
  contexts,
}: {
  itemIds: string[];
  title: string;
  recommendedContextId: string | null;
  alternatives: string[];
  contexts: ContextOption[];
}) {
  const defaultChoice = recommendedContextId
    ? `existing:${recommendedContextId}`
    : `new:${title}`;
  const [choice, setChoice] = useState(defaultChoice);
  const [error, formAction, pending] = useActionState(confirmContextPool, undefined);

  return (
    <form action={formAction} className="mt-4">
      <input type="hidden" name="memory_item_ids" value={JSON.stringify(itemIds)} />
      <div className="flex flex-wrap gap-2">
        <select
          name="context_choice"
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          className="min-w-56 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-zinc-900"
        >
          {!recommendedContextId && <option value={`new:${title}`}>Neu: {title}</option>}
          {alternatives.map((name) => (
            <option key={name} value={`new:${name}`}>Neu: {name}</option>
          ))}
          {contexts.map((context) => (
            <option key={context.id} value={`existing:${context.id}`}>
              Bestehend: {context.name}
            </option>
          ))}
          <option value="manual">Anderen Namen eingeben …</option>
        </select>
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-semibold text-background transition hover:opacity-85 disabled:opacity-50"
        >
          {pending ? "Wird übernommen …" : `Bestätigen (${itemIds.length})`}
        </button>
      </div>
      {choice === "manual" && (
        <input
          name="manual_name"
          required
          autoFocus
          placeholder="Kontextname eingeben"
          className="mt-2 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-zinc-900"
        />
      )}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}
