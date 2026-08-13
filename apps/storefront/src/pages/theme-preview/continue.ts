import { env as cfEnv } from "cloudflare:workers";
import type { APIRoute } from "astro";

import { createApiUrl, fetchWithRetry } from "@/lib/api/client";
import { createThemePreviewCookieHeader } from "@/lib/theme-preview-cookie";
import {
  normalizeThemePreviewDashboardOrigin,
  normalizeThemePreviewDevice,
  normalizeThemePreviewRoutePath,
} from "@/lib/theme-preview-route";

export const prerender = false;

const CONTINUATION_CODE = /^tpc_[A-Za-z0-9_-]{48}$/;
const MAX_FORM_BYTES = 2_048;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const FORM_FIELDS = ["continuationCode", "path", "device"] as const;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

function textResponse(message: string, status: number, extraHeaders?: HeadersInit): Response {
  return new Response(message, {
    status,
    headers: {
      ...PRIVATE_HEADERS,
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

export const POST: APIRoute = async ({ request, url }) => {
  const trustedDashboardOrigin = normalizeThemePreviewDashboardOrigin(cfEnv.DASHBOARD_URL);
  if (!trustedDashboardOrigin) {
    return textResponse("Theme preview continuation is not configured.", 503);
  }
  if (request.headers.get("Origin") !== trustedDashboardOrigin) {
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

    const upstream = await fetchWithRetry(
      createApiUrl("/storefront/agent-continuations/theme-preview"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ continuationCode }),
        cache: "no-store",
      },
      0,
      4_000,
      true,
      false,
    );
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return unavailable();
    }

    const payload = await upstream.json() as unknown;
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
    const token = typeof data?.token === "string" ? data.token : "";
    const cookie = createThemePreviewCookieHeader(token);
    if (!cookie) return unavailable();

    const destination = new URL("/theme-preview", url.origin);
    destination.searchParams.set("path", path);
    destination.searchParams.set("device", device);
    const headers = new Headers({
      ...PRIVATE_HEADERS,
      "Location": destination.toString(),
    });
    headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 303, headers });
  } catch {
    return unavailable();
  }
};

export const ALL: APIRoute = async () => textResponse("Method not allowed", 405, {
  "Allow": "POST",
});
