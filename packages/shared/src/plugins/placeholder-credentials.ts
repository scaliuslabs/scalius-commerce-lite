// Obvious placeholder credentials ("test", "your api key", "123456"): a
// provider must never be called with one, so a provider's own settings
// (`providers.<kind>[].settings`) read as not configured while one holds such
// a value, and a settings save refuses it. AGENTS.md: "treat obvious
// dummy/placeholder credentials as not configured".

/** Masked secrets as the dashboard shows them (12 bullets); never a placeholder. */
export const MASKED_CREDENTIAL = "••••••••••••";

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

const PLACEHOLDER_WORD_VALUES = new Set(["changeme", "dummy", "example", "placeholder", "sample"]);

/** Whether a credential value is an obvious placeholder (empty and masked values are not). */
export function looksLikePlaceholderCredential(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === MASKED_CREDENTIAL) return false;

  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!normalized) return false;
  if (PLACEHOLDER_EXACT_VALUES.has(normalized)) return true;
  if (/^([0-9])\1{3,}$/.test(normalized)) return true;
  if (/^1234567890?$/.test(normalized)) return true;

  const words = trimmed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((word) => PLACEHOLDER_WORD_VALUES.has(word))) return true;
  if (words.length <= 2 && words.some((word) => word === "test" || word === "demo")) return true;
  if (words[0] === "your" && words.some((word) => word === "key" || word === "token" || word === "api")) return true;

  return false;
}

/** The first labelled value that is a placeholder, as a merchant-facing error; null when none is. */
export function firstPlaceholderConfigError(
  fields: Array<[label: string, value: string | null | undefined]>,
): string | null {
  for (const [label, value] of fields) {
    if (looksLikePlaceholderCredential(value)) {
      return `${label} looks like a placeholder. Save a real provider value first.`;
    }
  }
  return null;
}
