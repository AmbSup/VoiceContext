"use client";

import { useState, useTransition } from "react";
import { updateEntity } from "./actions";
import { ENTITY_TYPES, formatEntityType } from "@/lib/entities";

export function EditEntityForm({
  entityId,
  name,
  type,
}: {
  entityId: string;
  name: string;
  type: string;
}) {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        setError(undefined);
        startTransition(async () => {
          const result = await updateEntity(entityId, formData);
          if (result) setError(result);
        });
      }}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950"
    >
      <div className="flex flex-1 min-w-40 flex-col gap-1">
        <label htmlFor="name" className="text-sm text-zinc-600 dark:text-zinc-400">
          Name
        </label>
        <input
          id="name"
          name="name"
          defaultValue={name}
          required
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-black dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="type" className="text-sm text-zinc-600 dark:text-zinc-400">
          Typ
        </label>
        <select
          id="type"
          name="type"
          defaultValue={type}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-black dark:border-white/[.145] dark:text-zinc-50"
        >
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {formatEntityType(t)}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {pending ? "Speichere …" : "Speichern"}
      </button>
    </form>
  );
}
