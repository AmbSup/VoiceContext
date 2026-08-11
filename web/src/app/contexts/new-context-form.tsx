"use client";

import { useActionState } from "react";
import { createContext } from "./actions";

export function NewContextForm() {
  const [error, formAction, pending] = useActionState(
    createContext,
    undefined,
  );

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-lg border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950"
    >
      <div className="flex flex-col gap-1">
        <label
          htmlFor="name"
          className="text-sm text-zinc-600 dark:text-zinc-400"
        >
          Name
        </label>
        <input
          id="name"
          name="name"
          required
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-black dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="description"
          className="text-sm text-zinc-600 dark:text-zinc-400"
        >
          Beschreibung (optional)
        </label>
        <textarea
          id="description"
          name="description"
          rows={2}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-black dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {pending ? "Anlegen …" : "Kontext anlegen"}
      </button>
    </form>
  );
}
