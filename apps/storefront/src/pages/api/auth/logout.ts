// src/pages/api/auth/logout.ts
// Same-origin logout proxy.
//
// Clears cs_tok/cs_auth and every order receipt cookie from the browser
// (same-origin Set-Cookie), so a shared phone no longer opens the previous
// buyer's receipts, and forwards the logout to the API worker to revoke the
// D1 session.
//
// Uses BACKEND_API service binding in production, HTTP to the local API in dev.

import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { resolveBackendTarget } from "@/lib/api/transport";

export const prerender = false;

const BACKEND_LOGOUT_PATH = "/api/v1/customer-auth/logout";
// Cookie names and paths from lib/order-receipt-cookie.ts.
const RECEIPT_PREFIX = "scalius_receipt_";
const RECEIPT_FINALIZE_PREFIX = "scalius_receipt_finalize_";

/** Expiry headers for each receipt cookie the request carries, plus its checkout finalize marker. */
function receiptCookieClears(cookieHeader: string | null): string[] {
  const names = new Set((cookieHeader ?? "").split(";")
    .map((part) => part.trim().split("=")[0] ?? "")
    .filter((name) => /^[A-Za-z0-9_-]+$/.test(name)
      && name.startsWith(RECEIPT_PREFIX)
      && !name.startsWith(RECEIPT_FINALIZE_PREFIX)));
  // The finalize marker lives on Path=/order-success, so this request never
  // carries it; it shares the receipt cookie's order suffix.
  return [...names].flatMap((name) => [
    `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
    `${RECEIPT_FINALIZE_PREFIX}${name.slice(RECEIPT_PREFIX.length)}=; Max-Age=0; Path=/order-success; HttpOnly; Secure; SameSite=Lax`,
  ]);
}

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return new Response(JSON.stringify({ success: false, error: "Cross-origin cookie request denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cookieHeader = request.headers.get("Cookie");
  // Clear cookies as host-only (no Domain attr) + SameSite=Lax (same-origin proxy)
  const cookieHeaders: string[] = [
    "cs_tok=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure",
    "cs_auth=; Max-Age=0; Path=/; SameSite=Lax; Secure",
    ...receiptCookieClears(cookieHeader),
  ];

  // Forward the logout to the backend so the D1 session is revoked.
  // Best-effort: even if this fails, the cookies are cleared above.
  const target = resolveBackendTarget(BACKEND_LOGOUT_PATH);
  if (target) {
    try {
      await target.fetch(target.url, {
        method: "POST",
        headers: { Cookie: cookieHeader || "" },
      });
    } catch {
      // Non-critical: cookie clearing is the primary logout mechanism
    }
  }

  const headers = new Headers();
  for (const c of cookieHeaders) {
    headers.append("Set-Cookie", c);
  }

  // If called from a browser form (Accept: text/html), redirect to homepage.
  // If called from JS fetch, return JSON (fetch follows redirects anyway,
  // but logoutCustomer() ignores the response body).
  const accept = request.headers.get("Accept") || "";
  if (accept.includes("text/html")) {
    headers.set("Location", "/");
    return new Response(null, { status: 302, headers });
  }

  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ success: true }), { status: 200, headers });
};
