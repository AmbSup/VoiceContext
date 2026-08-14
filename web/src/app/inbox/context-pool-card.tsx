"use client";

import { useActionState } from "react";
import { ContextPoolForm } from "./context-pool-form";
import { dismissContextPool } from "./actions";

interface ContextOption {
  id: string;
  name: string;
}

export function ContextPoolCard({
  index,
  title,
  reason,
  itemIds,
  itemContents,
  recommendedContextId,
  alternatives,
  contexts,
}: {
  index: number;
  title: string;
  reason: string;
  itemIds: string[];
  itemContents: string[];
  recommendedContextId: string | null;
  alternatives: string[];
  contexts: ContextOption[];
}) {
  const [dismissError, dismissAction, dismissPending] = useActionState(
    dismissContextPool,
    undefined,
  );

  return (
    <li className="glass-card rounded-2xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400">
            Pool {index + 1}
          </p>
          <h3 className="mt-1 text-xl font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-zinc-500">{reason}</p>
        </div>
        <span className="shrink-0 rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-950 dark:text-violet-300">
          {itemIds.length} Themen
        </span>
      </div>
      <ul className="mt-4 space-y-2 border-l-2 border-violet-200 pl-4 dark:border-violet-900">
        {itemContents.map((content, itemIndex) => (
          <li key={itemIds[itemIndex]} className="text-sm text-zinc-700 dark:text-zinc-300">
            {content}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <ContextPoolForm
          itemIds={itemIds}
          title={title}
          recommendedContextId={recommendedContextId}
          alternatives={alternatives}
          contexts={contexts}
        />
        <form action={dismissAction}>
          <input
            type="hidden"
            name="memory_item_ids"
            value={JSON.stringify(itemIds)}
          />
          <button
            type="submit"
            disabled={dismissPending}
            className="mb-0.5 rounded-full px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40"
            aria-label={`Pool ${title} dauerhaft verwerfen`}
          >
            {dismissPending ? "Wird gelöscht …" : "Pool löschen"}
          </button>
          {dismissError && (
            <p className="mt-1 max-w-xs text-sm text-red-600" role="alert">
              {dismissError}
            </p>
          )}
        </form>
      </div>
    </li>
  );
}
