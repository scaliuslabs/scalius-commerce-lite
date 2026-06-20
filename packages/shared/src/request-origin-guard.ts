const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function normalizeRequestOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function hasCookieCredentials(request: Request): boolean {
  return Boolean(request.headers.get("Cookie")?.trim());
}

export function shouldRejectCrossOriginCookieRequest(request: Request): boolean {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return false;
  if (!hasCookieCredentials(request)) return false;

  const origin = request.headers.get("Origin");
  if (!origin) return false;

  const requestOrigin = normalizeRequestOrigin(request.url);
  const submittedOrigin = normalizeRequestOrigin(origin);
  if (!requestOrigin || !submittedOrigin) return true;

  return requestOrigin !== submittedOrigin;
}
