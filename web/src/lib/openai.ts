// Shared OpenAI helpers for the (post-hoc, batch) side of the app — the
// Realtime/WebRTC path used by the live dialog has its own token-minting
// route (api/realtime-token) and never goes through here.

const EMBEDDING_MODEL = "text-embedding-3-small"; // 1536 dims — matches memory_items.embedding (see 0001_init_schema.sql)

function openaiConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_API_BASE_URL ?? "https://api.openai.com";
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  return { apiKey, baseUrl };
}

// Batched on purpose: one call for N texts instead of N calls, and the
// response is re-sorted by `index` since OpenAI does not guarantee the
// returned order matches the input order.
export async function createEmbeddings(
  texts: string[],
  safetyIdentifier: string,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const { apiKey, baseUrl } = openaiConfig();

  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": safetyIdentifier,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });

  if (!response.ok) {
    throw new Error(
      `OpenAI embeddings request failed (${response.status}): ${await response.text()}`,
    );
  }

  const body = await response.json();
  const data = body.data as { embedding: number[]; index: number }[];
  return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function createChatCompletion(params: {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  responseSchema: { name: string; schema: object };
  safetyIdentifier: string;
}): Promise<string> {
  const { apiKey, baseUrl } = openaiConfig();

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": params.safetyIdentifier,
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: params.responseSchema.name,
          strict: true,
          schema: params.responseSchema.schema,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `OpenAI request failed (${response.status}): ${await response.text()}`,
    );
  }

  const completion = await response.json();
  const content = completion.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("OpenAI returned no content");
  }
  return content;
}
