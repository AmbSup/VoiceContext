import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { corsJson, corsPreflight } from "@/lib/cors";

const WEB_SEARCH_MODEL = "gpt-5.4-mini";

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(request: Request) {
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

  const response = await fetch(`${baseUrl}/v1/responses`, {
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
    }),
  });
  if (!response.ok) {
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
    return corsJson({ error: "Web search returned no answer" }, { status: 502 });
  }
  return corsJson({ answer });
}
