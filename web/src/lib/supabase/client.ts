import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client. Needs NEXT_PUBLIC_SUPABASE_URL and
// NEXT_PUBLIC_SUPABASE_ANON_KEY from the EU-region project created in
// Phase 0 of docs/implementation-plan.md — see .env.local.example.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
