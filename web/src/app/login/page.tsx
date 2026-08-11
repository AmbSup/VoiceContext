"use client";

import { useActionState } from "react";
import { login, signup } from "./actions";

export default function LoginPage() {
  const [loginError, loginAction, loginPending] = useActionState(
    login,
    undefined,
  );
  const [signupError, signupAction, signupPending] = useActionState(
    signup,
    undefined,
  );

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 dark:bg-black">
      <form className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-black/[.08] bg-white p-8 dark:border-white/[.145] dark:bg-zinc-950">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          KI Voice Context Engine
        </h1>

        <div className="flex flex-col gap-1">
          <label htmlFor="email" className="text-sm text-zinc-600 dark:text-zinc-400">
            E-Mail
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-black dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="password" className="text-sm text-zinc-600 dark:text-zinc-400">
            Passwort
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={6}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-black dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>

        {(loginError || signupError) && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {loginError ?? signupError}
          </p>
        )}

        <div className="flex gap-3">
          <button
            formAction={loginAction}
            disabled={loginPending || signupPending}
            className="flex-1 rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {loginPending ? "Anmelden …" : "Anmelden"}
          </button>
          <button
            formAction={signupAction}
            disabled={loginPending || signupPending}
            className="flex-1 rounded-full border border-black/[.08] px-5 py-2 text-sm font-medium text-black transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-[#1a1a1a]"
          >
            {signupPending ? "Registrieren …" : "Registrieren"}
          </button>
        </div>
      </form>
    </div>
  );
}
