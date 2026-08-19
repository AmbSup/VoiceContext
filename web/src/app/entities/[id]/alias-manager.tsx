"use client";

import { useRef, useState, useTransition } from "react";
import { addAlias, removeAlias } from "./actions";

export function AliasManager({
  entityId,
  aliases,
}: {
  entityId: string;
  aliases: { id: string; alias: string }[];
}) {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
        Alternative Namen (Aliase)
      </p>
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
        Wird die Entität unter einem dieser Namen erwähnt, ordnet die
        Extraktion sie direkt hierher zu, statt eine neue Entität anzulegen.
      </p>
      {aliases.length > 0 && (
        <ul className="mb-3 flex flex-wrap gap-2">
          {aliases.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded-full bg-black/[.04] py-1 pl-3 pr-1.5 text-sm dark:bg-white/[.08]"
            >
              <span>{a.alias}</span>
              <button
                type="button"
                disabled={pending}
                aria-label={`Alias ${a.alias} entfernen`}
                onClick={() => {
                  setError(undefined);
                  startTransition(async () => {
                    const result = await removeAlias(a.id, entityId);
                    if (result) setError(result);
                  });
                }}
                className="grid size-5 place-items-center rounded-full text-zinc-500 hover:bg-black/[.08] hover:text-red-600 disabled:opacity-50 dark:hover:bg-white/[.12]"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          setError(undefined);
          startTransition(async () => {
            const result = await addAlias(entityId, formData);
            if (result) setError(result);
            else formRef.current?.reset();
          });
        }}
        className="flex gap-2"
      >
        <input
          name="alias"
          placeholder="z. B. Bob"
          required
          className="flex-1 rounded border border-black/[.08] bg-transparent px-3 py-1.5 text-sm text-black dark:border-white/[.145] dark:text-zinc-50"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-full border border-black/[.08] px-3 py-1.5 text-sm font-medium transition hover:bg-zinc-50 disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-zinc-900"
        >
          Hinzufügen
        </button>
      </form>
      {error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
