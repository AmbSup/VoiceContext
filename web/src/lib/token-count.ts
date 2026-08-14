import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

const encoding = new Tiktoken(o200kBase);

export function countTokens(text: string): number {
  return encoding.encode(text).length;
}

export function splitByTokenWindow(
  text: string,
  maxTokens: number,
  overlapTokens = 0,
): string[] {
  if (maxTokens <= 0) return [];
  const tokens = encoding.encode(text);
  if (tokens.length === 0) return [];

  const overlap = Math.min(Math.max(overlapTokens, 0), maxTokens - 1);
  const step = maxTokens - overlap;
  const chunks: string[] = [];
  for (let start = 0; start < tokens.length; start += step) {
    const chunk = encoding
      .decode(tokens.slice(start, Math.min(start + maxTokens, tokens.length)))
      .trim();
    if (chunk) chunks.push(chunk);
    if (start + maxTokens >= tokens.length) break;
  }
  return chunks;
}

export function truncateToTokens(
  text: string,
  maxTokens: number,
  keep: "start" | "end" = "start",
): string {
  if (maxTokens <= 0) return "";
  const tokens = encoding.encode(text);
  if (tokens.length <= maxTokens) return text;
  const selected =
    keep === "end" ? tokens.slice(tokens.length - maxTokens) : tokens.slice(0, maxTokens);
  return encoding.decode(selected).trim();
}
