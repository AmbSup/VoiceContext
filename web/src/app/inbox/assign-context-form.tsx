"use client";

import { useActionState } from "react";
import { assignToContext } from "./actions";

interface ContextOption {
  id: string;
  name: string;
}

export function AssignContextForm({
  memoryItemId,
  contexts,
}: {
  memoryItemId: string;
  contexts: ContextOption[];
}) {
  const [error, formAction, pending] = useActionState(
    assignToContext,
    undefined,
  );

  return (
    <form action={formAction} className="mt-3 flex flex-wrap items-center gap-2">
      <input type="hidden" name="memory_item_id" value={memoryItemId} />
      <select
        name="context_id"
        defaultValue=""
        className="min-w-44 rounded border border-black/[.08] bg-transparent px-2 py-1.5 text-sm text-black dark:border-white/[.145] dark:text-zinc-50"
      >
        <option value="">Bestehenden Kontext wählen …</option>
        {contexts.map((context) => (
          <option key={context.id} value={context.id}>
            {context.name}
          </option>
        ))}
      </select>
      <span className="text-xs text-zinc-400">oder</span>
      <input
        name="manual_context_name"
        placeholder="Neuen Kontext eingeben"
        className="min-w-48 flex-1 rounded border border-black/[.08] bg-transparent px-2 py-1.5 text-sm text-black placeholder:text-zinc-400 dark:border-white/[.145] dark:text-zinc-50"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {pending ? "Zuordnen …" : "Zuordnen"}
      </button>
      {error && (
        <p className="w-full text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
