const LOCAL_DEVELOPMENT_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

const HSTS_VALUE = "max-age=31536000; includeSubDomains";

function isLocalDevelopmentUrl(url: URL): boolean {
  return LOCAL_DEVELOPMENT_HOSTNAMES.has(url.hostname)
    || url.hostname.endsWith(".localhost");
}

/**
 * Redirect public plaintext requests before auth, cache, or application work.
 * Loopback HTTP remains available for local development.
 */
export function redirectPlaintextRequest(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || isLocalDevelopmentUrl(url)) {
    return null;
  }

  url.protocol = "https:";
  return new Response(null, {
    status: 308,
    headers: {
      "Cache-Control": "no-store",
      Location: url.toString(),
    },
  });
}

export type FrameProtection = "deny" | "same-origin" | "preserve";

/**
 * Apply browser transport and isolation headers to the final response. HSTS is
 * emitted only for HTTPS responses because browsers ignore it over plaintext.
 */
export function applyBaselineSecurityHeaders(
  request: Request,
  response: Response,
  options: { frameProtection?: FrameProtection } = {},
): Response {
  const headers = new Headers(response.headers);
  const url = new URL(request.url);

  if (url.protocol === "https:" && !isLocalDevelopmentUrl(url)) {
    headers.set("Strict-Transport-Security", HSTS_VALUE);
  }

  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  const frameProtection = options.frameProtection ?? "preserve";
  if (frameProtection === "deny") {
    headers.set("X-Frame-Options", "DENY");
  } else if (frameProtection === "same-origin") {
    headers.set("X-Frame-Options", "SAMEORIGIN");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
