const RELAY_PATHS = new Set([
  "/checkout/continue",
  "/agent/continue",
  "/theme-preview/continue",
  "/theme-preview/embed",
]);
/** Relays a parent window frames (the theme editor): they set their own frame-ancestors. */
const FRAMED_RELAY_PATHS = new Set(["/theme-preview/embed"]);
const READY_MESSAGE = "scalius-continuation-ready-v1";
const FIELDS_MESSAGE = "scalius-continuation-fields-v1";
const ACCEPTED_MESSAGE = "scalius-continuation-accepted-v1";

export function isTrustedBrowserContinuationPostOrigin(request: Request): boolean {
  const rawOrigin = request.headers.get("Origin");
  if (!rawOrigin) return false;
  try {
    const origin = new URL(rawOrigin);
    const target = new URL(request.url);
    return rawOrigin === origin.origin && origin.origin === target.origin;
  } catch {
    return false;
  }
}

export interface BrowserContinuationRelayField {
  name: string;
  pattern: string;
  maxBytes: number;
}

export function isBrowserContinuationRelayPathname(pathname: string): boolean {
  return RELAY_PATHS.has(pathname);
}

export function isFramedBrowserContinuationRelayPathname(pathname: string): boolean {
  return FRAMED_RELAY_PATHS.has(pathname);
}

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
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
  additionalParentOrigins: readonly string[] = [],
  options: {
    /** The relay runs in a frame and answers its parent (else its opener). */
    parent?: boolean;
    /** Origins that may frame the relay (with `parent`); none frames it otherwise. */
    frameAncestors?: readonly string[];
  } = {},
): Response {
  const spec = scriptJson(fields);
  const allowed = scriptJson(additionalParentOrigins);
  const peer = options.parent ? "window.parent" : "window.opener";
  const framed = options.parent === true && (options.frameAncestors?.length ?? 0) > 0;
  const script = `(() => {
  const fail = () => { document.body.textContent = "This secure continuation is invalid or expired."; };
  const trustedParentOrigin = (rawOrigin) => {
    try {
      const origin = new URL(rawOrigin);
      if (rawOrigin !== origin.origin) return false;
      if (origin.origin === window.location.origin) return true;
      if (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) return true;
      return ${allowed}.includes(origin.origin);
    } catch { return false; }
  };
  const receive = async (event) => {
    if (event.source !== PEER() || !trustedParentOrigin(event.origin)) return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.type !== ${scriptJson(FIELDS_MESSAGE)}) return;
    try {
      const payload = message.fields;
      const fields = ${spec};
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail();
      const keys = Object.keys(payload);
      if (keys.length !== fields.length || !fields.every((field) => keys.includes(field.name))) return fail();
      const body = new URLSearchParams();
      for (const field of fields) {
        const value = payload[field.name];
        if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > field.maxBytes || !(new RegExp(field.pattern)).test(value)) return fail();
        body.set(field.name, value);
      }
      const response = await fetch(window.location.pathname, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body,
        cache: "no-store",
        credentials: "same-origin",
        redirect: "follow",
        referrerPolicy: "no-referrer",
      });
      const destination = new URL(response.url);
      if (!response.ok || !response.redirected || destination.origin !== window.location.origin) return fail();
      PEER().postMessage({ type: ${scriptJson(ACCEPTED_MESSAGE)} }, event.origin);
      window.removeEventListener("message", receive);
      window.location.replace(destination.toString());
    } catch { fail(); }
  };
  if (!PEER() || PEER() === window) return fail();
  window.addEventListener("message", receive);
  PEER().postMessage({ type: ${scriptJson(READY_MESSAGE)} }, "*");
})();`.replace(/PEER\(\)/g, peer);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive"><title>Continue securely</title></head><body><noscript>JavaScript is required to continue securely.</noscript><script>${script}</script></body></html>`;
  const headers = new Headers({ ...PRIVATE_HEADERS, "Content-Type": "text/html; charset=utf-8" });
  if (framed) {
    // Only the listed origins may frame it; frame-ancestors governs, so no X-Frame-Options.
    headers.set("Content-Security-Policy", PRIVATE_HEADERS["Content-Security-Policy"].replace(
      "frame-ancestors 'none'",
      `frame-ancestors ${options.frameAncestors!.join(" ")}`,
    ));
    headers.delete("X-Frame-Options");
  }
  return new Response(html, { status: 200, headers });
}
