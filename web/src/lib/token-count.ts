import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

const encoding = new Tiktoken(o200kBase);

export function countTokens(text: string): number {
  return encoding.encode(text).length;
}
