import type { FormData } from "../MetaConversionsSettingsForm";

const MASKED_VALUE = "••••••••••••";
const PLACEHOLDER_CREDENTIALS = new Set([
  "dummy",
  "test",
  "example",
  "placeholder",
  "123456",
  "pixel123",
  "accesstoken",
  "badtoken",
  "token",
  "xxxx",
]);

function normalizedPlaceholderCandidate(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function isMetaConversionsPlaceholderCredential(value: string): boolean {
  const normalized = normalizedPlaceholderCandidate(value);
  return PLACEHOLDER_CREDENTIALS.has(normalized) || /^x{4,}$/.test(normalized);
}

function optionalTrimmedValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function getMetaConversionsSettingsIssue(data: FormData): string | null {
  const pixelId = optionalTrimmedValue(data.pixelId);
  const accessToken = optionalTrimmedValue(data.accessToken);
  const testEventCode = optionalTrimmedValue(data.testEventCode);

  if (pixelId && isMetaConversionsPlaceholderCredential(pixelId)) {
    return "Pixel ID looks like a dummy or placeholder value. Use the real Pixel ID from Meta Events Manager.";
  }

  if (
    accessToken &&
    accessToken !== MASKED_VALUE &&
    isMetaConversionsPlaceholderCredential(accessToken)
  ) {
    return "Access token looks like a dummy or placeholder value. Use the real token from Meta Events Manager.";
  }

  if (testEventCode && isMetaConversionsPlaceholderCredential(testEventCode)) {
    return "Test event code looks like a dummy or placeholder value. Use the code from Meta Events Manager test events.";
  }

  if (!data.isEnabled) {
    return null;
  }

  const missingFields = [
    pixelId ? null : "Pixel ID",
    accessToken ? null : "access token",
  ].filter((field): field is string => Boolean(field));

  if (missingFields.length > 0) {
    return `Meta Conversions API needs ${missingFields.join(" and ")} before it can be enabled.`;
  }

  return null;
}

export function getMetaConversionsEnableIssue(data: FormData): string | null {
  return getMetaConversionsSettingsIssue({ ...data, isEnabled: true });
}
