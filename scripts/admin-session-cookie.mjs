export function splitCombinedSetCookieHeader(value) {
  if (!value) return [];
  return String(value)
    .split(/,(?=\s*[^;,=\s]+=[^;]+)/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function extractSetCookieHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().filter(Boolean);
  }
  const combined = typeof headers.get === "function" ? headers.get("set-cookie") : null;
  return splitCombinedSetCookieHeader(combined);
}

export function buildCookieHeader(setCookieHeaders) {
  return setCookieHeaders
    .map((value) => String(value).split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}
