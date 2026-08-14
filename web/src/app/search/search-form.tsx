"use client";

import { useActionState } from "react";
import Link from "next/link";
import { search } from "./actions";
import {
  formatMemoryItemStatus,
  formatMemoryItemType,
  memoryItemStatusClasses,
} from "@/lib/memory-items";

export function SearchForm() {
  const [state, formAction, pending] = useActionState(search, undefined);

  return (
    <div className="flex flex-col gap-6">
      <form action={formAction} className="flex gap-2">
        <input
          type="text"
          name="query"
          required
          placeholder="Frag dein Wissen …"
          className="flex-1 rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black dark:border-white/[.145] dark:text-zinc-50"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          {pending ? "Suche …" : "Suchen"}
        </button>
      </form>

      {state?.error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}

      {state?.result && (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
            <p className="text-sm text-black dark:text-zinc-50">
              {state.result.answer}
            </p>
          </div>

          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400"
            aria-label="Verwendetes Retrieval-Token-Budget"
          >
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Retrieval-Kontext:
            </span>
            <span>
              {state.result.retrievalUsage.usedTokens.toLocaleString("de-DE")} /{" "}
              {state.result.retrievalUsage.maxTokens.toLocaleString("de-DE")} Tokens
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {state.result.retrievalUsage.selectedCount}{" "}
              {state.result.retrievalUsage.selectedCount === 1
                ? "Quelle"
                : "Quellen"}
            </span>
            {state.result.retrievalUsage.truncated && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                Budget erreicht
              </span>
            )}
          </div>

          {state.result.sources.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
                Quellen
              </h2>
              <ul className="flex flex-col gap-2">
                {state.result.sources.map((source) =>
                  source.kind === "context" ? (
                    <li
                      key={`context-${source.id}`}
                      className="rounded-lg border border-black/[.08] bg-white p-3 dark:border-white/[.145] dark:bg-zinc-950"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                          Kontext
                        </span>
                        <Link
                          href={`/contexts/${source.id}`}
                          className="text-xs text-zinc-500 hover:underline dark:text-zinc-400"
                        >
                          → {source.name}
                        </Link>
                      </div>
                      {source.description && (
                        <p className="mt-1 text-sm text-black dark:text-zinc-50">
                          {source.description}
                        </p>
                      )}
                    </li>
                  ) : source.kind === "document_chunk" ? (
                    <li
                      key={`document-chunk-${source.id}`}
                      className="rounded-lg border border-black/[.08] bg-white p-3 dark:border-white/[.145] dark:bg-zinc-950"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                          Dokument-Detail
                        </span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          {source.file_name} · Abschnitt {source.chunk_index + 1}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-black dark:text-zinc-50">
                        {source.content}
                      </p>
                    </li>
                  ) : source.kind === "segment" ? (
                    <li
                      key={`segment-${source.id}`}
                      className="rounded-lg border border-black/[.08] bg-white p-3 dark:border-white/[.145] dark:bg-zinc-950"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                          Abschnitt
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-black dark:text-zinc-50">
                        {source.content}
                      </p>
                    </li>
                  ) : (
                    <li
                      key={`memory-item-${source.id}`}
                      className="rounded-lg border border-black/[.08] bg-white p-3 dark:border-white/[.145] dark:bg-zinc-950"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                          {formatMemoryItemType(source.type)}
                        </span>
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${memoryItemStatusClasses(source.status)}`}
                        >
                          {formatMemoryItemStatus(source.status)}
                        </span>
                        {source.contexts.map((context) => (
                          <Link
                            key={context.id}
                            href={`/contexts/${context.id}`}
                            className="text-xs text-zinc-500 hover:underline dark:text-zinc-400"
                          >
                            → {context.name}
                          </Link>
                        ))}
                      </div>
                      <p className="mt-1 text-sm text-black dark:text-zinc-50">
                        {source.content}
                      </p>
                    </li>
                  ),
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
