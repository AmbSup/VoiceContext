export const REALTIME_MODEL = "gpt-realtime-2.1";

// Official OpenAI prices for gpt-realtime-2.1, in USD per 1M tokens.
// Source checked 2026-08-16:
// https://developers.openai.com/api/docs/models/gpt-realtime-2.1
// Audio pricing is unchanged from the prior "gpt-realtime" model; only
// textOutput went up ($24 vs $16) — a small share of a voice app's tokens.
const PRICE_PER_MILLION = {
  textInput: 4,
  cachedInput: 0.4,
  textOutput: 24,
  audioInput: 32,
  audioOutput: 64,
} as const;

export interface RealtimeUsageEventRow {
  dialog_session_id: string;
  created_at: string;
  payload: unknown;
}

export interface RealtimeUsageSummary {
  responseCount: number;
  sessionCount: number;
  inputTextTokens: number;
  inputAudioTokens: number;
  cachedInputTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
}

interface RealtimeResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: {
      text_tokens?: number;
      audio_tokens?: number;
    };
  };
  output_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function extractUsage(payload: unknown): {
  eventId: string | null;
  usage: RealtimeResponseUsage | null;
} {
  const payloadRecord = asRecord(payload);
  const event = asRecord(payloadRecord?.event) ?? payloadRecord;
  const response = asRecord(event?.response);
  const usage = asRecord(response?.usage) as RealtimeResponseUsage | null;
  return {
    eventId:
      typeof event?.event_id === "string"
        ? event.event_id
        : typeof response?.id === "string"
          ? response.id
          : null,
    usage,
  };
}

export function summarizeRealtimeUsage(
  rows: RealtimeUsageEventRow[],
): RealtimeUsageSummary {
  const sessions = new Set<string>();
  const seenEvents = new Set<string>();
  let responseCount = 0;
  let inputTextTokens = 0;
  let inputAudioTokens = 0;
  let cachedTextTokens = 0;
  let cachedAudioTokens = 0;
  let outputTextTokens = 0;
  let outputAudioTokens = 0;
  let totalTokens = 0;
  let firstRecordedAtMs = Number.POSITIVE_INFINITY;
  let lastRecordedAtMs = Number.NEGATIVE_INFINITY;

  for (const row of rows) {
    const { eventId, usage } = extractUsage(row.payload);
    if (!usage) continue;
    const dedupeKey = eventId
      ? `${row.dialog_session_id}:${eventId}`
      : `${row.dialog_session_id}:${row.created_at}:${responseCount}`;
    if (seenEvents.has(dedupeKey)) continue;
    seenEvents.add(dedupeKey);

    responseCount++;
    sessions.add(row.dialog_session_id);
    const createdAtMs = Date.parse(row.created_at);
    if (Number.isFinite(createdAtMs)) {
      firstRecordedAtMs = Math.min(firstRecordedAtMs, createdAtMs);
      lastRecordedAtMs = Math.max(lastRecordedAtMs, createdAtMs);
    }

    const inputDetails = usage.input_token_details;
    const outputDetails = usage.output_token_details;
    const cachedDetails = inputDetails?.cached_tokens_details;
    const rowInputText = finiteNumber(inputDetails?.text_tokens);
    const rowInputAudio = finiteNumber(inputDetails?.audio_tokens);
    const rowCachedText = finiteNumber(cachedDetails?.text_tokens);
    const rowCachedAudio = finiteNumber(cachedDetails?.audio_tokens);
    const rowCachedTotal = finiteNumber(inputDetails?.cached_tokens);

    inputTextTokens += rowInputText;
    inputAudioTokens += rowInputAudio;
    cachedTextTokens += rowCachedText;
    cachedAudioTokens += rowCachedAudio;
    // Older events may expose only the aggregate cached count. Treat the
    // unexplained remainder as cached text so it is still priced at the
    // documented cached-input rate without double counting.
    cachedTextTokens += Math.max(
      0,
      rowCachedTotal - rowCachedText - rowCachedAudio,
    );
    outputTextTokens += finiteNumber(outputDetails?.text_tokens);
    outputAudioTokens += finiteNumber(outputDetails?.audio_tokens);
    totalTokens += finiteNumber(usage.total_tokens);
  }

  const uncachedTextTokens = Math.max(0, inputTextTokens - cachedTextTokens);
  const uncachedAudioTokens = Math.max(
    0,
    inputAudioTokens - cachedAudioTokens,
  );
  const cachedInputTokens = cachedTextTokens + cachedAudioTokens;
  const estimatedCostUsd =
    (uncachedTextTokens * PRICE_PER_MILLION.textInput +
      uncachedAudioTokens * PRICE_PER_MILLION.audioInput +
      cachedInputTokens * PRICE_PER_MILLION.cachedInput +
      outputTextTokens * PRICE_PER_MILLION.textOutput +
      outputAudioTokens * PRICE_PER_MILLION.audioOutput) /
    1_000_000;

  return {
    responseCount,
    sessionCount: sessions.size,
    inputTextTokens,
    inputAudioTokens,
    cachedInputTokens,
    outputTextTokens,
    outputAudioTokens,
    totalTokens,
    estimatedCostUsd,
    firstRecordedAt: Number.isFinite(firstRecordedAtMs)
      ? new Date(firstRecordedAtMs).toISOString()
      : null,
    lastRecordedAt: Number.isFinite(lastRecordedAtMs)
      ? new Date(lastRecordedAtMs).toISOString()
      : null,
  };
}
