/**
 * Scanner Token API
 *
 * POST /api/scanner-token  -- Generate a one-time scanner auth token (admin-only)
 * GET  /api/scanner-token   -- Verify and claim a token (?token=XXX)
 */
import type { APIRoute } from "astro";
import { nanoid } from "nanoid";

export const prerender = false;

interface ScannerTokenPayload {
  adminId: string;
  adminName: string;
  createdAt: number;
  claimed: boolean;
  /** Unique session ID bound to the claiming device via HttpOnly cookie */
  sessionId?: string;
}

const TOKEN_TTL_SECONDS = 6 * 60 * 60; // 6 hours

const COOKIE_NAME = "scanner_sid";

function jsonResponse(
  data: Record<string, unknown>,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  return new Response(JSON.stringify(data), { status, headers });
}

function getCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

function buildCookieHeader(sessionId: string, maxAge: number): string {
  return `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

/**
 * POST -- Generate scanner token. Requires admin session.
 */
export const POST: APIRoute = async ({ locals }) => {
  const user = locals.user;
  const session = locals.session;

  if (!session || !user) {
    return jsonResponse({ success: false, error: "Authentication required" }, 401);
  }

  const env = locals._env;
  const kv = env?.CACHE as KVNamespace | undefined;

  if (!kv) {
    return jsonResponse({ success: false, error: "KV binding unavailable" }, 503);
  }

  const token = nanoid(32);
  const payload: ScannerTokenPayload = {
    adminId: user.id,
    adminName: user.name || user.email,
    createdAt: Date.now(),
    claimed: false,
  };

  await kv.put(`scanner:token:${token}`, JSON.stringify(payload), {
    expirationTtl: TOKEN_TTL_SECONDS,
  });

  return jsonResponse({ success: true, token });
};

/**
 * GET -- Verify and claim a scanner token.
 *
 * Device binding: On first claim, a sessionId is generated and stored in
 * both KV and an HttpOnly cookie. Subsequent requests must present the
 * matching cookie — this prevents the same token from being used on
 * multiple devices. The claiming device can refresh freely.
 */
export const GET: APIRoute = async ({ url, locals, request }) => {
  const token = url.searchParams.get("token");

  if (!token) {
    return jsonResponse({ success: false, error: "Token parameter required" }, 400);
  }

  const env = locals._env;
  const kv = env?.CACHE as KVNamespace | undefined;

  if (!kv) {
    return jsonResponse({ success: false, error: "KV binding unavailable" }, 503);
  }

  const raw = await kv.get(`scanner:token:${token}`);

  if (!raw) {
    return jsonResponse({ success: false, error: "Token invalid or expired" }, 401);
  }

  let payload: ScannerTokenPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return jsonResponse({ success: false, error: "Corrupt token data" }, 401);
  }

  const elapsedSeconds = Math.floor((Date.now() - payload.createdAt) / 1000);
  const remainingTtl = Math.max(TOKEN_TTL_SECONDS - elapsedSeconds, 60);

  // --- Already claimed: validate device binding ---
  if (payload.claimed && payload.sessionId) {
    const cookieSid = getCookie(request, COOKIE_NAME);
    if (cookieSid !== payload.sessionId) {
      return jsonResponse(
        { success: false, error: "Token already claimed by another device" },
        403,
      );
    }
    // Same device refreshing — re-set cookie to extend its lifetime
    return jsonResponse(
      { success: true, valid: true, adminName: payload.adminName },
      200,
      { "Set-Cookie": buildCookieHeader(payload.sessionId, remainingTtl) },
    );
  }

  // --- First claim: bind to this device ---
  const sessionId = nanoid(32);
  payload.claimed = true;
  payload.sessionId = sessionId;

  await kv.put(`scanner:token:${token}`, JSON.stringify(payload), {
    expirationTtl: remainingTtl,
  });

  return jsonResponse(
    { success: true, valid: true, adminName: payload.adminName },
    200,
    { "Set-Cookie": buildCookieHeader(sessionId, remainingTtl) },
  );
};
