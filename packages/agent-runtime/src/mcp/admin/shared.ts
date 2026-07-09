import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { JsonRecord } from "./types";

export const ADMIN_READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const ADMIN_PRODUCTS_MAX_STRING_LENGTH = 220;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function adminApiHeaders(cookie: string, userAgent?: string | null): Headers {
  const headers = new Headers({
    Accept: "application/json",
    Cookie: cookie,
  });
  const safeUserAgent = userAgent?.trim();
  if (safeUserAgent) {
    headers.set("User-Agent", safeUserAgent.slice(0, 256));
  }
  return headers;
}

export function failClosedStatus(status: number): number {
  if (status === 401 || status === 403) return status;
  if (status >= 400 && status < 500) return 403;
  return 503;
}

export async function parseJsonResponse(response: Response): Promise<JsonRecord | null> {
  try {
    const body = await response.json();
    return isRecord(body) ? body : { value: body };
  } catch {
    return null;
  }
}

function textFallback(body: JsonRecord): string {
  return JSON.stringify(body, null, 2);
}

export function toolResult(body: JsonRecord, isError = false): CallToolResult {
  return {
    structuredContent: body,
    content: [{ type: "text", text: textFallback(body) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function compactString(value: unknown, maxLength = ADMIN_PRODUCTS_MAX_STRING_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

export function compactPlainText(value: unknown, maxLength: number): string | null {
  const text = compactString(value, maxLength);
  if (!text) return null;

  const plain = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|td|th|section|article)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();

  return plain ? plain.slice(0, maxLength) : null;
}

export function compactNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function compactBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function compactTimestamp(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return compactString(value, 80);
}

export function setCompactString(
  target: JsonRecord,
  key: string,
  value: unknown,
  maxLength = ADMIN_PRODUCTS_MAX_STRING_LENGTH,
): void {
  const compact = compactString(value, maxLength);
  if (compact) target[key] = compact;
}

export function setCompactNumber(target: JsonRecord, key: string, value: unknown): void {
  const compact = compactNumber(value);
  if (compact !== null) target[key] = compact;
}

export function setCompactBoolean(target: JsonRecord, key: string, value: unknown): void {
  const compact = compactBoolean(value);
  if (compact !== null) target[key] = compact;
}

export function compactMaskedContact(value: unknown): string | null {
  const compact = compactString(value, 160);
  if (!compact) return null;
  return /[*•…xX]/.test(compact) ? compact : null;
}

export function setCompactTimestamp(target: JsonRecord, key: string, value: unknown): void {
  const compact = compactTimestamp(value);
  if (compact !== null) target[key] = compact;
}

export function compactAdminPagination(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const page = compactNumber(value.page);
  const limit = compactNumber(value.limit);
  const total = compactNumber(value.total);
  const totalPages = compactNumber(value.totalPages);
  if (page === null || limit === null || total === null || totalPages === null) {
    return null;
  }

  return { page, limit, total, totalPages };
}
