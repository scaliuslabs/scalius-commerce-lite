/**
 * Redeems a dashboard theme preview continuation: the relay page (GET)
 * receives the one-time code from the dashboard window by postMessage and
 * POSTs it here from the storefront's own origin; the code is exchanged
 * through service auth for the cookie-only preview bearer. Two places use
 * it: `/theme-preview/continue` (a new tab, landing on the preview canvas)
 * and `/theme-preview/embed` (the theme editor's frame, landing on the page
 * itself with a partitioned cookie the frame can carry).
 */
import { apiFetch } from "@/lib/api/transport";
import { getRuntimeApiBaseUrl, getRuntimeDashboardUrl } from "@/lib/api/runtime";
import { createThemePreviewCookieHeader } from "@/lib/theme-preview-cookie";
import {
  browserContinuationRelayResponse,
  isTrustedBrowserContinuationPostOrigin,
} from "@/lib/browser-continuation-relay";
import {
  normalizeThemePreviewDevice,
  normalizeThemePreviewRoutePath,
} from "@/lib/theme-preview-route";

const CONTINUATION_CODE = /^tpc_[A-Za-z0-9_-]{48}$/;
const MAX_FORM_BYTES = 2_048;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const FORM_FIELDS = ["continuationCode", "path", "device"] as const;
export const THEME_PREVIEW_PRIVATE_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

export type ThemePreviewContinuationMode = "tab" | "embed";

function textResponse(message: string, status: number, extraHeaders?: HeadersInit): Response {
  return new Response(message, {
    status,
    headers: {
      ...THEME_PREVIEW_PRIVATE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function unavailable(): Response {
  return textResponse("Theme preview continuation is unavailable or expired.", 410);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFormFields(form: URLSearchParams): boolean {
  const keys = [...form.keys()];
  return keys.length === FORM_FIELDS.length && FORM_FIELDS.every(
    (field) => form.getAll(field).length === 1,
  ) && keys.every((key) => FORM_FIELDS.includes(key as typeof FORM_FIELDS[number]));
}

function hasBoundedFormBody(request: Request, body: string): boolean {
  const actualLength = new TextEncoder().encode(body).byteLength;
  if (actualLength < 1 || actualLength > MAX_FORM_BYTES) return false;

  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isInteger(parsedLength) ||
      parsedLength !== actualLength ||
      parsedLength < 1 ||
      parsedLength > MAX_FORM_BYTES
    ) {
      return false;
    }
  }
  return true;
}

function originOf(value: string | undefined): string {
  try {
    return new URL(value ?? "").origin;
  } catch {
    return "";
  }
}

const RELAY_FIELDS = [
  { name: "continuationCode", pattern: CONTINUATION_CODE.source, maxBytes: 52 },
  { name: "path", pattern: "^/[^\\r\\n]{0,511}$", maxBytes: 512 },
  { name: "device", pattern: "^(?:full|desktop|mobile)$", maxBytes: 7 },
];

/**
 * The relay page. A new tab answers its opener (the dashboard or the API's
 * agent flow); the editor's frame answers only its parent, the dashboard,
 * which alone may frame it.
 */
export function themePreviewRelayResponse(mode: ThemePreviewContinuationMode): Response {
  const dashboardOrigin = originOf(getRuntimeDashboardUrl());
  if (mode === "embed") {
    return browserContinuationRelayResponse(RELAY_FIELDS, [dashboardOrigin].filter(Boolean), {
      parent: true,
      frameAncestors: [dashboardOrigin].filter(Boolean),
    });
  }
  const apiOrigin = originOf(getRuntimeApiBaseUrl());
  return browserContinuationRelayResponse(RELAY_FIELDS, [dashboardOrigin, apiOrigin].filter(Boolean));
}

/** The relay's POST: the code exchanged for the preview cookie, then the page to show. */
export async function redeemThemePreviewContinuation(
  request: Request,
  url: URL,
  mode: ThemePreviewContinuationMode,
): Promise<Response> {
  if (!isTrustedBrowserContinuationPostOrigin(request)) {
    return textResponse("Forbidden", 403);
  }

  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== FORM_CONTENT_TYPE) {
    return textResponse("Invalid theme preview continuation.", 400);
  }

  try {
    const body = await request.text();
    if (!hasBoundedFormBody(request, body)) {
      return textResponse("Invalid theme preview continuation.", 400);
    }
    const form = new URLSearchParams(body);
    if (!hasExactFormFields(form)) {
      return textResponse("Invalid theme preview continuation.", 400);
    }

    const continuationCode = form.get("continuationCode") ?? "";
    const rawPath = form.get("path") ?? "";
    const rawDevice = form.get("device") ?? "";
    const path = normalizeThemePreviewRoutePath(rawPath);
    const device = normalizeThemePreviewDevice(rawDevice);
    if (
      !CONTINUATION_CODE.test(continuationCode) ||
      path !== rawPath ||
      device !== rawDevice
    ) {
      return textResponse("Invalid theme preview continuation.", 400);
    }

    const upstream = await apiFetch(
      "/storefront/agent-continuations/theme-preview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ continuationCode }),
        cache: "no-store",
      },
      { retries: 0, timeout: 4_000, auth: true, logTerminalFailure: false },
    );
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return unavailable();
    }

    const payload = await upstream.json() as unknown;
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
    const token = typeof data?.token === "string" ? data.token : "";
    const cookie = createThemePreviewCookieHeader(token, { embedded: mode === "embed" });
    if (!cookie) return unavailable();

    // The tab lands on the preview canvas; the editor's frame on the page itself.
    const destination = mode === "embed" ? new URL(path, url.origin) : new URL("/theme-preview", url.origin);
    if (mode === "tab") {
      destination.searchParams.set("path", path);
      destination.searchParams.set("device", device);
    }
    const headers = new Headers({
      ...THEME_PREVIEW_PRIVATE_HEADERS,
      "Location": destination.toString(),
    });
    headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 303, headers });
  } catch {
    return unavailable();
  }
}

export const themePreviewMethodNotAllowed = () => textResponse("Method not allowed", 405, {
  "Allow": "GET, POST",
});
