import { ValidationError } from "@scalius/core/errors";

import { hashAssistantArguments } from "./assistant-crypto";

export const ASSISTANT_INSTANCE_ID_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/u;
export const ASSISTANT_CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export async function hashAssistantDispatchClaim(
  token: string,
): Promise<string> {
  return hashAssistantArguments({
    version: "assistant-computer-dispatch-claim:v1",
    token,
  });
}

export function requireAssistantPattern(
  value: string,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ValidationError(`${label} is invalid.`);
  }
  return value;
}

export function randomAssistantBase64Url(size: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
