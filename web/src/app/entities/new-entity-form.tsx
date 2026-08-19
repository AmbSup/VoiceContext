"use client";

import { useActionState } from "react";
import { createEntity } from "./actions";
import { ENTITY_TYPES, formatEntityType } from "@/lib/entities";

export function NewEntityForm() {
  const [error, formAction, pending] = useActionState(createEntity, undefined);

  return (
    <form
      action={formAction}
      className="mb-8 flex flex-col gap-3 rounded-lg border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950 sm:flex-row sm:items-end"
    >
      <div className="flex flex-1 flex-col gap-1">
        <label htmlFor="name" className="text-sm text-zinc-600 dark:text-zinc-400">
          Name
        </label>
        <input
          id="name"
          name="name"
          required
          placeholder="z. B. Erika Musterfrau"
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
          defaultValue="person"
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-black dark:border-white/[.145] dark:text-zinc-50"
        >
          {ENTITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {formatEntityType(type)}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 sm:self-center">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {pending ? "Anlegen …" : "Entität anlegen"}
      </button>
    </form>
  );
}
