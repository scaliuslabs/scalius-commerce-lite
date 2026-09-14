// src/pages/api/auth/logout.ts
// Same-origin logout proxy.
//
// Clears cs_tok/cs_auth cookies from the browser (same-origin Set-Cookie)
// and forwards the logout to the API worker to revoke the D1 session.
//
// Uses BACKEND_API service binding in production, HTTP to the local API in dev.

import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { resolveBackendTarget } from "@/lib/api/backend-target";

export const prerender = false;

const BACKEND_LOGOUT_PATH = "/api/v1/customer-auth/logout";

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return new Response(JSON.stringify({ success: false, error: "Cross-origin cookie request denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Clear cookies as host-only (no Domain attr) + SameSite=Lax (same-origin proxy)
  const cookieHeaders: string[] = [
    "cs_tok=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure",
    "cs_auth=; Max-Age=0; Path=/; SameSite=Lax; Secure",
  ];

  // Forward the logout to the backend so the D1 session is revoked.
  // Best-effort: even if this fails, the cookies are cleared above.
  const target = resolveBackendTarget(BACKEND_LOGOUT_PATH);
  if (target) {
    try {
      await target.fetch(target.url, {
        method: "POST",
        headers: { Cookie: request.headers.get("Cookie") || "" },
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
