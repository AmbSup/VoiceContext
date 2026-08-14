"use client";

import { useActionState } from "react";
import { resolveMemoryConflict } from "./actions";
import {
  formatConflictVerdict,
  formatMemoryItemConfidence,
  formatMemoryItemType,
} from "@/lib/memory-items";

interface ConflictItem {
  type: string;
  content: string;
}

export function ConflictReviewCard({
  reviewId,
  verdict,
  confidence,
  newItem,
  existingItem,
}: {
  reviewId: string;
  verdict: string;
  confidence: string;
  newItem: ConflictItem;
  existingItem: ConflictItem;
}) {
  const [error, action, pending] = useActionState(
    resolveMemoryConflict,
    undefined,
  );

  return (
    <li className="glass-card rounded-2xl p-5">
      <div className="flex items-start justify-between gap-4">
        <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          {formatConflictVerdict(verdict)}
        </span>
        <span className="text-xs text-zinc-500">
          {formatMemoryItemConfidence(confidence)}
        </span>
      </div>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Neu erfasst
          </p>
          <p className="mt-1 text-sm text-black dark:text-zinc-50">
            {newItem.content}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {formatMemoryItemType(newItem.type)}
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Bestehend
          </p>
          <p className="mt-1 text-sm text-black dark:text-zinc-50">
            {existingItem.content}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {formatMemoryItemType(existingItem.type)}
          </p>
        </div>
      </div>
      <form action={action} className="mt-4 flex flex-wrap items-center gap-2">
        <input type="hidden" name="review_id" value={reviewId} />
        <button
          type="submit"
          name="resolution"
          value="apply_new"
          disabled={pending}
          className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          Neuen übernehmen
        </button>
        <button
          type="submit"
          name="resolution"
          value="keep_existing"
          disabled={pending}
          className="rounded-full border border-black/[.08] px-4 py-2 text-sm font-medium transition hover:bg-zinc-50 disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-zinc-900"
        >
          Bestehenden behalten
        </button>
        <button
          type="submit"
          name="resolution"
          value="keep_both"
          disabled={pending}
          className="rounded-full px-4 py-2 text-sm font-medium text-zinc-500 transition hover:bg-zinc-50 disabled:opacity-50 dark:hover:bg-zinc-900"
        >
          Beide behalten
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
