import type { APIRoute } from "astro";
import { createApiUrl, fetchWithRetry } from "@/lib/api/client";
import { createAgentContinuationCookieHeader } from "@/lib/agent-continuation-cookie";

export const prerender = false;

const MAX_BODY_BYTES = 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const BOOTSTRAP_CODE = /^acb_[A-Za-z0-9_-]{20}_[A-Za-z0-9_-]{43}$/;
const CONTINUATION_ID = /^acn_[A-Za-z0-9_-]{20}$/;

function failure(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isTrustedBootstrapOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    const submitted = new URL(origin);
    const target = new URL(request.url);
    if (submitted.origin === target.origin) return true;
    return submitted.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(submitted.hostname);
  } catch {
    return false;
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!isTrustedBootstrapOrigin(request)) {
    return failure("Cross-origin request denied.", 403);
  }
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return failure("Request body is too large.", 413);
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return failure("Form-encoded bootstrap is required.", 415);
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return failure("Request body is too large.", 413);
  }
  const continuationCode = new URLSearchParams(body).get("continuationCode")?.trim() ?? "";
  if (!BOOTSTRAP_CODE.test(continuationCode)) {
    return failure("This secure storefront link is invalid or expired.", 400);
  }

  try {
    const upstream = await fetchWithRetry(
      createApiUrl("/storefront/agent-continuations/bootstrap"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ continuationCode }),
        cache: "no-store",
      },
      0,
      REQUEST_TIMEOUT_MS,
      true,
      false,
    );
    const payload = asRecord(await upstream.json().catch(() => null));
    const data = asRecord(payload?.data);
    const id = typeof data?.id === "string" ? data.id : "";
    const expiresAt = typeof data?.expiresAt === "string" ? Date.parse(data.expiresAt) : Number.NaN;
    if (!upstream.ok || !CONTINUATION_ID.test(id) || !Number.isFinite(expiresAt)) {
      return failure("This secure storefront link is invalid or expired.", upstream.ok ? 502 : 410);
    }
    const cookie = createAgentContinuationCookieHeader(id, (expiresAt - Date.now()) / 1_000);
    if (!cookie) return failure("This secure storefront link could not be stored.", 502);
    return new Response(null, {
      status: 303,
      headers: {
        Location: `/agent/continue/${encodeURIComponent(id)}`,
        "Set-Cookie": cookie,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    });
  } catch {
    return failure("Secure storefront service is unavailable.", 502);
  }
};

export const ALL: APIRoute = async () => failure("Method not allowed.", 405);
