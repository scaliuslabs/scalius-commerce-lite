/**
 * `<dashboard>/api/scanner-token`: turns a one-time scanner pairing token
 * (minted by `POST /api/v1/admin/auth/scanner-link`) into a scanner cookie on
 * the dashboard origin, or refreshes an existing scanner session.
 *
 * The token travels only in a same-origin POST body, never in a URL.
 */
import { consumeScannerTokenClaim } from "@scalius/core/auth/scanner-token-claims";
import { UnauthorizedError } from "@scalius/core/errors";
import { getDb } from "@scalius/database/client";
import {
  SCANNER_COOKIE_NAME,
  SCANNER_SESSION_TTL_SECONDS,
  buildScannerSessionCookie,
  getScannerSessionKey,
  parseCookie,
  type ScannerSessionPayload,
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

async function readScannerSession(
  request: Request,
  kv: KVNamespace,
): Promise<{ sessionId: string; session: ScannerSessionPayload } | null> {
  const sessionId = parseCookie(request.headers.get("Cookie"), SCANNER_COOKIE_NAME);
  if (!sessionId) return null;
  const raw = await kv.get(await getScannerSessionKey(sessionId));
  if (!raw) return null;
  try {
    return { sessionId, session: JSON.parse(raw) as ScannerSessionPayload };
  } catch {
    return null;
  }
}

async function startScannerSession(
  request: Request,
  kv: KVNamespace,
  sessionId: string,
  session: ScannerSessionPayload,
): Promise<Response> {
  await kv.put(await getScannerSessionKey(sessionId), JSON.stringify(session), {
    expirationTtl: SCANNER_SESSION_TTL_SECONDS,
  });
  const cookie = buildScannerSessionCookie(sessionId, SCANNER_SESSION_TTL_SECONDS, {
    secure: new URL(request.url).protocol === "https:",
  });
  return json({ success: true, valid: true, adminName: session.adminName }, 200, cookie);
}

async function refreshExistingSession(
  request: Request,
  kv: KVNamespace,
  nowMs: number,
  missing: Response,
): Promise<Response> {
  const existing = await readScannerSession(request, kv);
  if (!existing) return missing;
  return startScannerSession(request, kv, existing.sessionId, {
    ...existing.session,
    lastSeenAt: nowMs,
  });
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

  const kv = env.CACHE;
  if (typeof token !== "string") {
    return refreshExistingSession(
      request,
      kv,
      nowMs,
      json({ success: false, error: "Scanner session required" }, 401),
    );
  }

  const sessionId = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  try {
    const claim = await consumeScannerTokenClaim(getDb(env), { token, sessionId, nowMs });
    return startScannerSession(request, kv, sessionId, {
      adminId: claim.adminId,
      adminName: claim.adminName,
      createdAt: nowMs,
      lastSeenAt: nowMs,
      claimTokenHash: claim.tokenHash,
    });
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    // A reloaded scanner page re-posts its spent token; keep its session.
    return refreshExistingSession(
      request,
      kv,
      nowMs,
      json({ success: false, error: "Token invalid or expired" }, 401),
    );
  }
}
