import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Supabase's *default* "Confirm signup" email template points at Supabase's
// own hosted /auth/v1/verify endpoint, which verifies the token and then
// redirects to the Site URL carrying the session as a URL fragment
// (#access_token=...) — invisible to our server, so @supabase/ssr's
// cookie-based session never gets set from that flow.
//
// This route replaces that hop: the Supabase Dashboard's email template
// (Auth > Email Templates > Confirm signup) must be changed to link here
// directly instead, e.g.:
//   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/
// See https://supabase.com/docs/guides/auth/server-side/nextjs.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/";

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      redirect(next);
    }
  }

  redirect(`${origin}/login?error=Bestätigungslink ungültig oder abgelaufen`);
}
