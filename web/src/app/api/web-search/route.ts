import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { corsJson, corsPreflight } from "@/lib/cors";
import { logPerf, PerfTimer } from "@/lib/perf-log";

const WEB_SEARCH_MODEL = "gpt-5.4-mini";
const WEB_SEARCH_TIMEOUT_MS = 10_500;
// "before" half of a before/after comparison against Fast mode (2x token
// price, up to 2.5x faster per OpenAI) — off for now so /performance
// collects a Default-tier baseline first. Flip once that baseline exists.
const WEB_SEARCH_SERVICE_TIER: string | undefined = undefined;

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(request: Request) {
  const timer = new PerfTimer();
  const accessToken = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    return corsJson({ error: "Not authenticated" }, { status: 401 });
  }

  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(accessToken);
  if (authError || !user) {
    return corsJson({ error: "Not authenticated" }, { status: 401 });
  }
  timer.mark("auth");

  let query: string | undefined;
  try {
    const body = await request.json();
    query = (body?.query as string | undefined)?.trim();
  } catch {
    return corsJson({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!query) {
    return corsJson({ error: "query is required" }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_API_BASE_URL ?? "https://api.openai.com";
  if (!apiKey) {
    return corsJson(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 500 },
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, WEB_SEARCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": user.id,
      },
      body: JSON.stringify({
        model: WEB_SEARCH_MODEL,
        tools: [{ type: "web_search" }],
        input: query,
        ...(WEB_SEARCH_SERVICE_TIER
          ? { service_tier: WEB_SEARCH_SERVICE_TIER }
          : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      await logPerf(supabase, { route: "/api/web-search", timer });
      return corsJson(
        {
          error: "Web search timed out",
          detail:
            "Die Websuche hat länger als 10,5 Sekunden gedauert. Bitte erneut versuchen.",
        },
        { status: 504 },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  timer.mark("openai_search");
  if (!response.ok) {
    await logPerf(supabase, { route: "/api/web-search", timer });
    return corsJson(
      { error: "Web search failed", detail: await response.text() },
      { status: 502 },
    );
  }

  const result = await response.json();
  const answer = (result.output ?? [])
    .filter((item: { type?: string }) => item.type === "message")
    .flatMap((item: { content?: unknown[] }) => item.content ?? [])
    .filter(
      (content: { type?: string; text?: string }) =>
        content.type === "output_text" && typeof content.text === "string",
    )
    .map((content: { text: string }) => content.text)
    .join("\n")
    .trim();

  if (!answer) {
    await logPerf(supabase, { route: "/api/web-search", timer });
    return corsJson({ error: "Web search returned no answer" }, { status: 502 });
  }
  await logPerf(supabase, { route: "/api/web-search", timer });
  return corsJson({ answer });
}
