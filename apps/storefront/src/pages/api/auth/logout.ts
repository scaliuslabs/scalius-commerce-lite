// src/pages/api/auth/logout.ts
// Same-origin logout proxy.
//
// Browsers increasingly block cross-origin Set-Cookie in fetch responses
// (even with SameSite=None + credentials:include). Because cs_tok is
// HttpOnly, only a Set-Cookie header can clear it — JavaScript cannot.
//
// This endpoint:
//   1. Forwards the logout to the backend (deletes KV session).
//   2. Returns Set-Cookie headers from the SAME origin (store.wrygo.com)
//      so the browser always processes them.

import type { APIRoute } from "astro";

const BACKEND_LOGOUT_PATH = "/api/v1/customer-auth/logout";

export const POST: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const hostname = url.hostname;

  // Derive root domain (e.g. "wrygo.com" from "store.wrygo.com")
  const parts = hostname.split(".");
  const isCustomDomain =
    parts.length >= 2 &&
    hostname !== "localhost" &&
    !hostname.startsWith("127.") &&
    !hostname.startsWith("192.168.");
  const domainAttr = isCustomDomain
    ? `; Domain=.${parts.slice(-2).join(".")}`
    : "";

  const sameSite = isCustomDomain ? "None" : "Lax";

  // Build Set-Cookie headers that delete both cs_tok and cs_auth
  const cookieHeaders: string[] = [
    // Host-only clears (cookies set without Domain attribute)
    `cs_tok=; Max-Age=0; Path=/; HttpOnly; SameSite=${sameSite}; Secure`,
    `cs_auth=; Max-Age=0; Path=/; SameSite=${sameSite}; Secure`,
  ];

  if (domainAttr) {
    // Domain-scoped clears (cookies set with Domain=.wrygo.com)
    cookieHeaders.push(
      `cs_tok=; Max-Age=0; Path=/${domainAttr}; HttpOnly; SameSite=${sameSite}; Secure`,
      `cs_auth=; Max-Age=0; Path=/${domainAttr}; SameSite=${sameSite}; Secure`,
    );
  }

  // Forward the logout to the backend so the KV session is deleted.
  // Best-effort: even if this fails, the cookies are cleared above.
  const runtimeEnv = locals.runtime?.env;
  const backendBase =
    (runtimeEnv?.PUBLIC_API_BASE_URL as string) ||
    (runtimeEnv?.PUBLIC_API_URL as string)?.replace(/\/api\/v1\/?$/, "") ||
    import.meta.env.PUBLIC_API_BASE_URL ||
    import.meta.env.PUBLIC_API_URL?.replace(/\/api\/v1\/?$/, "") ||
    "";

  if (backendBase) {
    try {
      await fetch(`${backendBase}${BACKEND_LOGOUT_PATH}`, {
        method: "POST",
        headers: {
          Cookie: request.headers.get("Cookie") || "",
        },
      });
    } catch {
      // Non-critical: cookie clearing is the primary logout mechanism
    }
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  for (const c of cookieHeaders) {
    headers.append("Set-Cookie", c);
  }

  return new Response(JSON.stringify({ success: true }), { status: 200, headers });
};
