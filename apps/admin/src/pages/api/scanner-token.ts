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
}

const TOKEN_TTL_SECONDS = 6 * 60 * 60; // 6 hours

function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
 */
export const GET: APIRoute = async ({ url, locals }) => {
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

  if (payload.claimed) {
    return jsonResponse({ success: false, error: "Token already claimed" }, 401);
  }

  // Mark as claimed and keep the remaining TTL (re-derive from creation time)
  const elapsedSeconds = Math.floor((Date.now() - payload.createdAt) / 1000);
  const remainingTtl = Math.max(TOKEN_TTL_SECONDS - elapsedSeconds, 60); // minimum 60s

  payload.claimed = true;
  await kv.put(`scanner:token:${token}`, JSON.stringify(payload), {
    expirationTtl: remainingTtl,
  });

  return jsonResponse({
    success: true,
    valid: true,
    adminName: payload.adminName,
  });
};
