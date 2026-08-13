const RELAY_PREFIX = "scalius-continuation-v1:";
const MAX_RELAY_NAME_LENGTH = 16_384;
const MAX_RELAY_PAYLOAD_BYTES = 8_192;
const RELAY_PATHS = new Set(["/agent/continue", "/theme-preview/continue"]);
const FORM_CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
] as const;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function isTrustedBrowserContinuationPostOrigin(
  request: Request,
  additionalOrigins: readonly string[] = [],
): boolean {
  const rawOrigin = request.headers.get("Origin");
  if (!rawOrigin) return false;
  try {
    const origin = new URL(rawOrigin);
    const target = new URL(request.url);
    if (rawOrigin !== origin.origin) return false;
    if (origin.origin === target.origin) return true;
    if (origin.protocol === "http:" && isLoopbackHostname(origin.hostname)) return true;
    return additionalOrigins.includes(origin.origin);
  } catch {
    return false;
  }
}

export function isForbiddenStorefrontCrossOriginFormRequest(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
  const sameOrigin = request.headers.get("Origin") === new URL(request.url).origin;
  const contentType = request.headers.get("Content-Type");
  if (contentType !== null) {
    return FORM_CONTENT_TYPES.some((candidate) =>
      contentType.toLowerCase().includes(candidate)
    ) && !sameOrigin;
  }
  return !sameOrigin;
}

export interface BrowserContinuationRelayField {
  name: string;
  pattern: string;
  maxBytes: number;
}

export function isBrowserContinuationRelayPathname(pathname: string): boolean {
  return RELAY_PATHS.has(pathname);
}

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function browserContinuationRelayResponse(
  fields: readonly BrowserContinuationRelayField[],
): Response {
  const spec = scriptJson(fields);
  const script = `(() => {
  const fail = () => { document.body.textContent = "This secure continuation is invalid or expired."; };
  const raw = window.name;
  window.name = "";
  try {
    const prefix = ${scriptJson(RELAY_PREFIX)};
    if (typeof raw !== "string" || raw.length > ${MAX_RELAY_NAME_LENGTH} || !raw.startsWith(prefix)) return fail();
    const encoded = raw.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return fail();
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - encoded.length % 4) % 4);
    const binary = atob(base64);
    if (binary.length < 1 || binary.length > ${MAX_RELAY_PAYLOAD_BYTES}) return fail();
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    const fields = ${spec};
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail();
    const keys = Object.keys(payload);
    if (keys.length !== fields.length || !fields.every((field) => keys.includes(field.name))) return fail();
    const form = document.createElement("form");
    form.method = "post";
    form.action = window.location.pathname;
    form.hidden = true;
    for (const field of fields) {
      const value = payload[field.name];
      if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > field.maxBytes || !(new RegExp(field.pattern)).test(value)) return fail();
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = field.name;
      input.value = value;
      form.append(input);
    }
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Continue securely";
    form.append(button);
    document.body.replaceChildren(form);
    form.submit();
  } catch {
    fail();
  }
})();`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive"><title>Continue securely</title></head><body><noscript>JavaScript is required to continue securely.</noscript><script>${script}</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
