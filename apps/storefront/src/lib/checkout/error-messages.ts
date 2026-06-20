const DEFAULT_CHECKOUT_ERROR = "Order creation failed";

type ErrorRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ErrorRecord {
  return typeof value === "object" && value !== null;
}

function parseJsonErrorString(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed || !["[", "{"].includes(trimmed[0])) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function collectMessages(value: unknown): string[] {
  if (typeof value === "string") {
    const parsed = parseJsonErrorString(value);
    if (parsed !== null) return collectMessages(parsed);

    const message = value.trim();
    return message && message !== "[object Object]" ? [message] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectMessages(item));
  }

  if (!isRecord(value)) return [];

  const messages: string[] = [];

  for (const key of ["details", "issues", "errors", "itemIssues", "lineIssues"]) {
    if (key in value) {
      messages.push(...collectMessages(value[key]));
    }
  }

  if ("error" in value) {
    messages.push(...collectMessages(value.error));
  }

  if (typeof value.message === "string") {
    messages.push(...collectMessages(value.message));
  }

  return messages;
}

export function getCheckoutErrorMessage(
  error: unknown,
  fallback = DEFAULT_CHECKOUT_ERROR,
): string {
  const messages = collectMessages(error);
  const uniqueMessages = [...new Set(messages.map((message) => message.trim()))]
    .filter(Boolean)
    .filter((message) => message !== "Invalid input data");

  if (uniqueMessages.length > 0) {
    return uniqueMessages.join(". ");
  }

  return fallback;
}
