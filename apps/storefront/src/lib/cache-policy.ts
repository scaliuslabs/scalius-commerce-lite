const PRIVATE_SESSION_COOKIE_NAMES = ["cs_tok", "cs_auth"];

function hasNamedCookie(cookieHeader: string, cookieNames: readonly string[]): boolean {
  const names = new Set(cookieNames);

  for (const chunk of cookieHeader.split(";")) {
    const [rawName] = chunk.trim().split("=", 1);
    if (rawName && names.has(rawName)) return true;
  }

  return false;
}

export function requestHasPrivateSession(headers: Headers): boolean {
  if (headers.has("Authorization")) return true;

  const cookieHeader = headers.get("Cookie");
  if (!cookieHeader) return false;

  return hasNamedCookie(cookieHeader, PRIVATE_SESSION_COOKIE_NAMES);
}

const CACHEABLE_PUBLIC_CONTENT_TYPES = [
  "text/html",
  "application/xml",
  "text/xml",
  "application/xslt+xml",
  "text/plain",
];

export function isCacheablePublicResponse(response: Response): boolean {
  if (response.status !== 200) return false;
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (
    !CACHEABLE_PUBLIC_CONTENT_TYPES.some((type) =>
      contentType.includes(type),
    )
  ) {
    return false;
  }
  if (response.headers.has("Set-Cookie")) return false;

  const cacheControl = response.headers.get("Cache-Control")?.toLowerCase() ?? "";
  if (cacheControl.includes("private") || cacheControl.includes("no-store")) {
    return false;
  }

  return true;
}
