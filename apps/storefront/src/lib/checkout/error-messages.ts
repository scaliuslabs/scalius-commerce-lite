const DEFAULT_CHECKOUT_ERROR = "Order creation failed";
const GENERIC_CHECKOUT_ERRORS = new Set([
  "",
  DEFAULT_CHECKOUT_ERROR,
  "Payment failed",
  "Order creation failed (400)",
  "Order creation failed (401)",
  "Order creation failed (409)",
  "Order creation failed (429)",
  "Order creation failed (500)",
  "Order creation failed (502)",
  "Order creation failed (503)",
  "Order creation failed (504)",
]);

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

export function getCheckoutStatusErrorMessage(
  status: number | undefined,
  fallback = DEFAULT_CHECKOUT_ERROR,
): string {
  const message = fallback.trim();
  const shouldUseStatusCopy =
    GENERIC_CHECKOUT_ERRORS.has(message) ||
    /^Order creation failed \(\d{3}\)$/.test(message);

  if (!shouldUseStatusCopy) {
    return message || DEFAULT_CHECKOUT_ERROR;
  }

  switch (status) {
    case 401:
      return "Your sign-in session expired. Please sign in again or continue as a guest.";
    case 409:
      return "This checkout was already submitted or changed in another tab. Please review your cart and try again.";
    case 429:
      return "Too many checkout attempts. Please wait a moment and try again.";
    case 502:
    case 503:
    case 504:
      return "Checkout is temporarily unavailable. Please try again shortly.";
    default:
      return message || DEFAULT_CHECKOUT_ERROR;
  }
}
