export function normalizeAbsoluteStorefrontOriginUrl(
  value: string | null | undefined,
): string | null {
  const rawUrl = value?.trim();
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (
      (parsed.pathname && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

const LOCAL_HOSTNAME = /^(?:localhost|.+\.localhost|\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * Public storefronts are HTTPS-only: a plain-HTTP request for a named host
 * gets a permanent redirect even when the zone's "Always use HTTPS" is off.
 * Loopback and IP-literal hosts stay reachable over HTTP for local development.
 */
export function httpsRedirectResponse(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || LOCAL_HOSTNAME.test(url.hostname)) return null;
  url.protocol = "https:";
  return new Response(null, { status: 308, headers: { Location: url.toString() } });
}
