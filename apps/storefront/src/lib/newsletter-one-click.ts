// RFC 8058 one-click unsubscribe, at the storefront gateway (worker.ts).
//
// Marketing e-mails carry `List-Unsubscribe: <store>/newsletter/unsubscribe
// ?token=u1.…` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. The
// mail provider then POSTs `List-Unsubscribe=One-Click` (a form body) to that
// URL from its own servers: no cookies and no Origin. Astro's CSRF check
// refuses every form-encoded POST whose Origin is not the store's, so such a
// request would never reach the page. The signed token in the URL is the
// whole authorisation (it can only unsubscribe one channel), so the cross-site
// check has nothing to protect here; the gateway hands exactly this request
// on as a JSON body the page recognises, and nothing else changes. Any other
// body, path or method passes through untouched (and Astro's check applies).
//
// Without the gateway (`astro dev`), a one-click POST is refused with 403; the
// unsubscribe page and its button work the same either way.

export const ONE_CLICK_UNSUBSCRIBE_PATH = "/newsletter/unsubscribe";
export const ONE_CLICK_FIELD = "List-Unsubscribe";
export const ONE_CLICK_VALUE = "One-Click";
/** The one-click body is 26 bytes; a multipart envelope adds a little. */
const ONE_CLICK_MAX_BODY_BYTES = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a parsed JSON body is the one-click body (as the gateway hands it on). */
export function isOneClickJson(body: unknown): boolean {
  return isRecord(body) && Object.keys(body).length === 1 && body[ONE_CLICK_FIELD] === ONE_CLICK_VALUE;
}

/**
 * A request body as UTF-8 text, or null past `maxBytes` or when it is not
 * text. Read as a stream, so a missing or false Content-Length cannot get
 * past the limit.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (!Number.isFinite(declared) || declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Not awaited: one half of a cloned (teed) body settles only once its twin is done too.
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The posted fields of a urlencoded, multipart or untyped body. */
async function postedFields(request: Request, text: string): Promise<Array<[string, string]> | null> {
  const contentType = request.headers.get("Content-Type") ?? "";
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  try {
    if (type === "multipart/form-data") {
      const form = await new Response(text, { headers: { "Content-Type": contentType } }).formData();
      return [...form.entries()].flatMap(([key, value]) => (typeof value === "string" ? [[key, value] as [string, string]] : []));
    }
    if (type === "" || type === "application/x-www-form-urlencoded" || type === "text/plain") {
      return [...new URLSearchParams(text.trim())];
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * A mail client's one-click unsubscribe as the request the page handles
 * (`{"List-Unsubscribe":"One-Click"}`, JSON, the same URL and token), or
 * null for any other request.
 */
export async function oneClickUnsubscribeRequest(request: Request): Promise<Request | null> {
  if (request.method !== "POST") return null;
  const url = new URL(request.url);
  if (url.pathname !== ONE_CLICK_UNSUBSCRIBE_PATH || !url.searchParams.get("token")) return null;
  const type = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type === "application/json" || !request.body) return null;
  const text = await readBoundedText(request.clone(), ONE_CLICK_MAX_BODY_BYTES);
  if (text === null) return null;
  const fields = await postedFields(request, text);
  if (!fields || fields.length !== 1 || fields[0]![0] !== ONE_CLICK_FIELD || fields[0]![1] !== ONE_CLICK_VALUE) return null;
  const headers = new Headers(request.headers);
  for (const name of ["Content-Type", "Content-Length", "Cookie", "Origin", "Referer"]) headers.delete(name);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "text/plain");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ [ONE_CLICK_FIELD]: ONE_CLICK_VALUE }),
  });
}
