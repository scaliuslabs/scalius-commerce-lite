// src/pages/api/auth/logout.ts
// Same-origin logout proxy.
//
// Clears cs_tok/cs_auth cookies from the browser (same-origin Set-Cookie)
// and forwards the logout to the API worker to revoke the D1 session.
//
// Uses BACKEND_API service binding in production, HTTP in dev.

import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";

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
  const env = (() => {
    try {
      const e = cfEnv as unknown as Env;
      return (e?.BACKEND_API || e?.PUBLIC_API_BASE_URL || e?.ASSETS) ? e : undefined;
    } catch { return undefined; }
  })();

  try {
    let fetcher: typeof fetch = fetch;
    let targetUrl: string;
    const canUseServiceBinding = Boolean(env?.BACKEND_API && !import.meta.env.DEV);

    if (canUseServiceBinding) {
      // Production: service binding (zero-latency)
      targetUrl = `http://api.internal${BACKEND_LOGOUT_PATH}`;
      fetcher = env!.BACKEND_API.fetch.bind(env!.BACKEND_API);
    } else {
      const apiBase = env?.PUBLIC_API_BASE_URL as string;
      if (!apiBase) throw new Error("PUBLIC_API_BASE_URL not configured");
      targetUrl = `${apiBase}${BACKEND_LOGOUT_PATH}`;
    }

    await fetcher(targetUrl, {
      method: "POST",
      headers: { Cookie: request.headers.get("Cookie") || "" },
    });
  } catch {
    // Non-critical: cookie clearing is the primary logout mechanism
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
