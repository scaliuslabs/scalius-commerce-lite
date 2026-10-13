/**
 * `<dashboard>/api/scanner-token`: turns a one-time scanner pairing token
 * (minted by `POST /api/v1/admin/auth/scanner-link`) into a scanner cookie on
 * the dashboard origin, or refreshes an existing scanner session. The session
 * is the consumed claim row in the relational database (`session_expires_at`).
 *
 * The token travels only in a same-origin POST body, never in a URL.
 */
import { consumeScannerTokenClaim, readScannerSession } from "@scalius/core/auth/scanner-token-claims";
import { UnauthorizedError } from "@scalius/core/errors";
import { getDb, type Database } from "@scalius/database/client";
import {
  SCANNER_COOKIE_NAME,
  SCANNER_SESSION_TTL_SECONDS,
  buildScannerSessionCookie,
  parseCookie,
} from "@scalius/shared/scanner-auth";
import { isForeignDashboardRequest } from "../middleware/cookie-origin-guard";

function json(data: Record<string, unknown>, status = 200, cookie?: string): Response {
  const headers: Record<string, string> = { "Cache-Control": "private, no-store, max-age=0" };
  if (cookie) headers["Set-Cookie"] = cookie;
  return Response.json(data, { status, headers });
}

async function readToken(request: Request): Promise<unknown> {
  if (request.method.toUpperCase() !== "POST") return undefined;
  try {
    const body = await request.json() as { token?: unknown } | null;
    return body && typeof body === "object" ? body.token : undefined;
  } catch {
    return undefined;
  }
}

function sessionResponse(request: Request, sessionId: string, adminName: string): Response {
  const cookie = buildScannerSessionCookie(sessionId, SCANNER_SESSION_TTL_SECONDS, {
    secure: new URL(request.url).protocol === "https:",
  });
  return json({ success: true, valid: true, adminName }, 200, cookie);
}

/** Slides the cookie's live session (a database row) another full lifetime. */
async function refreshExistingSession(
  request: Request,
  db: Database,
  nowMs: number,
  missing: Response,
): Promise<Response> {
  const sessionId = parseCookie(request.headers.get("Cookie"), SCANNER_COOKIE_NAME);
  if (!sessionId) return missing;
  const session = await readScannerSession(db, sessionId, { nowMs, refresh: true });
  return session ? sessionResponse(request, sessionId, session.adminName) : missing;
}

export async function handleScannerSessionRequest(
  request: Request,
  env: Env,
  nowMs = Date.now(),
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }
  if (new URL(request.url).searchParams.has("token")) {
    return json({ success: false, error: "Scanner tokens are not accepted in URLs" }, 400);
  }
  if (method === "POST" && isForeignDashboardRequest(request, env.BETTER_AUTH_URL)) {
    return json({ success: false, error: "Cross-origin scanner exchange denied" }, 403);
  }

  const token = await readToken(request);
  if (
    token !== undefined &&
    (typeof token !== "string" || token.length < 20 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token))
  ) {
    return json({ success: false, error: "Scanner token is invalid" }, 400);
  }

  const db = getDb(env);
  if (typeof token !== "string") {
    return refreshExistingSession(
      request,
      db,
      nowMs,
      json({ success: false, error: "Scanner session required" }, 401),
    );
  }

  const sessionId = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  try {
    const claim = await consumeScannerTokenClaim(db, { token, sessionId, nowMs });
    return sessionResponse(request, sessionId, claim.adminName);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    // A reloaded scanner page re-posts its spent token; keep its session.
    return refreshExistingSession(
      request,
      db,
      nowMs,
      json({ success: false, error: "Token invalid or expired" }, 401),
    );
  }
}
