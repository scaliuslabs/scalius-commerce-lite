const RELAY_PATHS = new Set([
  "/checkout/continue",
  "/agent/continue",
  "/theme-preview/continue",
]);
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
  additionalParentOrigins: readonly string[] = [],
): Response {
  const spec = scriptJson(fields);
  const allowed = scriptJson(additionalParentOrigins);
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
  const receive = (event) => {
    if (event.source !== window.opener || !trustedParentOrigin(event.origin)) return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.type !== ${scriptJson(FIELDS_MESSAGE)}) return;
    try {
      const payload = message.fields;
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
      window.opener.postMessage({ type: ${scriptJson(ACCEPTED_MESSAGE)} }, event.origin);
      window.removeEventListener("message", receive);
      form.submit();
    } catch { fail(); }
  };
  if (!window.opener) return fail();
  window.addEventListener("message", receive);
  window.opener.postMessage({ type: ${scriptJson(READY_MESSAGE)} }, "*");
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
