// What makes saved SMS credentials usable: readable (decrypted with
// CREDENTIAL_ENCRYPTION_KEY) and not an obvious placeholder. Shared by the
// gateways' `configure` and the settings save.

import type { SmsSettings } from "../../modules/settings";
import type { StoredSms } from "./port";

/** Masked secrets as the dashboard shows them (12 bullets). */
export const MASKED_SMS_SECRET = "••••••••••••";

const PLACEHOLDER_EXACT_VALUES = new Set([
  "000000",
  "111111",
  "123456",
  "123456789",
  "apikey",
  "apitoken",
  "changeme",
  "changeit",
  "demo",
  "dummy",
  "example",
  "password",
  "sample",
  "secret",
  "test",
  "testing",
  "token",
  "yourapikey",
  "yourapikeyhere",
  "yourapi",
  "yourtoken",
  "yourtokenhere",
]);

const PLACEHOLDER_WORD_VALUES = new Set([
  "changeme",
  "dummy",
  "example",
  "placeholder",
  "sample",
]);

export function firstPlaceholderConfigError(
  fields: Array<[label: string, value: string | null | undefined]>,
): string | null {
  for (const [label, value] of fields) {
    if (looksLikePlaceholderCredential(value)) {
      return `${label} looks like a placeholder. Save a real provider value before enabling SMS.`;
    }
  }
  return null;
}

function looksLikePlaceholderCredential(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === MASKED_SMS_SECRET) return false;

  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!normalized) return false;
  if (PLACEHOLDER_EXACT_VALUES.has(normalized)) return true;
  if (/^([0-9])\1{3,}$/.test(normalized)) return true;
  if (/^1234567890?$/.test(normalized)) return true;

  const words = trimmed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((word) => PLACEHOLDER_WORD_VALUES.has(word))) return true;
  if (words.length <= 2 && words.some((word) => word === "test" || word === "demo")) {
    return true;
  }
  if (words[0] === "your" && words.some((word) => word === "key" || word === "token" || word === "api")) {
    return true;
  }

  return false;
}

/** Why a gateway's saved credentials cannot be used: its secret is unreadable, or a field is a placeholder. */
export function smsCredentialIssue(
  stored: StoredSms,
  secret: keyof SmsSettings,
  fields: Array<[label: string, value: string | null | undefined]>,
): string | null {
  return stored.secretErrors[secret] ?? firstPlaceholderConfigError(fields);
}
