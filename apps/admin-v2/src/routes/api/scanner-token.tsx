import { createFileRoute } from "@tanstack/react-router";
import {
  consumeScannerTokenClaim,
  createScannerTokenClaim,
  type ConsumedScannerTokenClaim,
} from "@scalius/core/auth";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { UnauthorizedError } from "@scalius/core/errors";
import { getDb, type Database } from "@scalius/database/client";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import {
  SCANNER_COOKIE_NAME,
  SCANNER_SESSION_TTL_SECONDS,
  buildScannerSessionCookie,
  getScannerSessionKey,
  parseCookie,
  type ScannerSessionPayload,
} from "@scalius/shared/scanner-auth";

interface CloudflareEnv {
  DB?: D1Database;
  CACHE?: Pick<KVNamespace, "get" | "put" | "delete">;
}

interface ScannerAuthUser {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  twoFactorEnabled?: boolean | null;
}

interface ScannerAuthSession {
  twoFactorVerified?: boolean | null;
}

interface ScannerAuthResult {
  session?: ScannerAuthSession | null;
  user?: ScannerAuthUser | null;
}

interface ScannerRbacContext {
  permissions: Set<string>;
  isSuperAdmin: boolean;
}

interface CreateScannerTokenDeps {
  getAuthSession?: (headers: Headers) => Promise<ScannerAuthResult | null>;
  loadUserPermissions?: (
    userId: string,
    userRole?: string | null,
  ) => Promise<ScannerRbacContext>;
  getEnv?: () => Promise<CloudflareEnv> | CloudflareEnv;
  getDb?: (env: CloudflareEnv) => Database;
  createToken?: () => Promise<string> | string;
  createTokenClaim?: (
    db: Database,
    input: {
      token: string;
      adminId: string;
      adminName: string;
      nowMs?: number;
    },
  ) => Promise<void>;
  now?: () => number;
}

interface ExchangeScannerTokenDeps {
  getEnv?: () => Promise<CloudflareEnv> | CloudflareEnv;
  getDb?: (env: CloudflareEnv) => Database;
  createSessionId?: () => Promise<string> | string;
  consumeTokenClaim?: (
    db: Database,
    input: {
      token: string;
      sessionId: string;
      nowMs?: number;
    },
  ) => Promise<ConsumedScannerTokenClaim>;
  now?: () => number;
}

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

function shouldUseSecureCookie(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === "https:";
}

function canMintScannerToken(rbac: ScannerRbacContext): boolean {
  return (
    rbac.isSuperAdmin ||
    (rbac.permissions.has(PERMISSIONS.PRODUCTS_VIEW) &&
      rbac.permissions.has(PERMISSIONS.PRODUCTS_EDIT))
  );
}

function isAdminTwoFactorVerified(authResult: ScannerAuthResult): boolean {
  return (
    authResult.user?.twoFactorEnabled !== true ||
    authResult.session?.twoFactorVerified === true
  );
}

async function defaultGetAuthSession(headers: Headers): Promise<ScannerAuthResult | null> {
  const { getAuthSession } = await import("~/lib/auth.server");
  return getAuthSession(headers) as Promise<ScannerAuthResult | null>;
}

async function defaultLoadUserPermissions(
  userId: string,
  userRole?: string | null,
): Promise<ScannerRbacContext> {
  const { loadUserPermissions } = await import("~/middleware/rbac.server");
  return loadUserPermissions(userId, userRole);
}

async function defaultGetEnv(): Promise<CloudflareEnv> {
  const { env } = await import("cloudflare:workers");
  return env as CloudflareEnv;
}

async function defaultCreateToken(): Promise<string> {
  const { nanoid } = await import("nanoid");
  return nanoid(40);
}

function getScannerDb(
  env: CloudflareEnv,
  getDbOverride?: (env: CloudflareEnv) => Database,
): Database | null {
  if (!env.DB) return null;
  return getDbOverride ? getDbOverride(env) : getDb(env as Env);
}

export async function handleCreateScannerToken(
  request: Request,
  deps: CreateScannerTokenDeps = {},
): Promise<Response> {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return jsonResponse({ success: false, error: "Cross-origin cookie request denied" }, 403);
  }

  const getAuthSession = deps.getAuthSession ?? defaultGetAuthSession;
  const loadUserPermissions = deps.loadUserPermissions ?? defaultLoadUserPermissions;
  const authResult = await getAuthSession(request.headers);

  if (!authResult?.session || !authResult?.user) {
    return jsonResponse({ success: false, error: "Authentication required" }, 401);
  }

  if (!isAdminTwoFactorVerified(authResult)) {
    return jsonResponse({ success: false, error: "Two-factor verification required" }, 403);
  }

  const user = authResult.user;
  const rbac = await loadUserPermissions(user.id, user.role);
  if (!canMintScannerToken(rbac)) {
    return jsonResponse({ success: false, error: "Inventory permission required" }, 403);
  }

  const env = deps.getEnv ? await deps.getEnv() : await defaultGetEnv();
  const kv = env.CACHE;
  const db = getScannerDb(env, deps.getDb);
  if (!kv || !db) {
    return jsonResponse({ success: false, error: "Scanner auth storage unavailable" }, 503);
  }

  const token = deps.createToken ? await deps.createToken() : await defaultCreateToken();
  const now = deps.now ? deps.now() : Date.now();
  const adminName = user.name || user.email || "";

  const createTokenClaimForRequest = deps.createTokenClaim ?? createScannerTokenClaim;
  await createTokenClaimForRequest(db, {
    token,
    adminId: user.id,
    adminName,
    nowMs: now,
  });

  return jsonResponse({ success: true, token });
}

async function readScannerSession(
  request: Request,
  kv: Pick<KVNamespace, "get" | "put">,
): Promise<{ sessionId: string; session: ScannerSessionPayload } | null> {
  const sessionId = parseCookie(request.headers.get("Cookie"), SCANNER_COOKIE_NAME);
  if (!sessionId) return null;

  const sessionKey = await getScannerSessionKey(sessionId);
  const raw = await kv.get(sessionKey);
  if (!raw) return null;

  try {
    return { sessionId, session: JSON.parse(raw) as ScannerSessionPayload };
  } catch {
    return null;
  }
}

async function refreshScannerSession(
  request: Request,
  kv: Pick<KVNamespace, "put">,
  sessionId: string,
  session: ScannerSessionPayload,
  nowMs = Date.now(),
): Promise<Response> {
  const refreshed: ScannerSessionPayload = {
    ...session,
    lastSeenAt: nowMs,
  };
  await kv.put(await getScannerSessionKey(sessionId), JSON.stringify(refreshed), {
    expirationTtl: SCANNER_SESSION_TTL_SECONDS,
  });

  return jsonResponse(
    { success: true, valid: true, adminName: refreshed.adminName },
    200,
    {
      "Set-Cookie": buildScannerSessionCookie(sessionId, SCANNER_SESSION_TTL_SECONDS, {
        secure: shouldUseSecureCookie(request),
      }),
    },
  );
}

export async function handleExchangeScannerToken(
  request: Request,
  deps: ExchangeScannerTokenDeps = {},
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const now = deps.now ? deps.now() : Date.now();

  const env = deps.getEnv ? await deps.getEnv() : await defaultGetEnv();
  const kv = env.CACHE;
  if (!kv) {
    return jsonResponse({ success: false, error: "KV binding unavailable" }, 503);
  }

  if (!token) {
    const existingSession = await readScannerSession(request, kv);
    if (!existingSession) {
      return jsonResponse({ success: false, error: "Scanner session required" }, 401);
    }
    return refreshScannerSession(
      request,
      kv,
      existingSession.sessionId,
      existingSession.session,
      now,
    );
  }

  const db = getScannerDb(env, deps.getDb);
  if (!db) {
    const existingSession = await readScannerSession(request, kv);
    if (existingSession) {
      return refreshScannerSession(
        request,
        kv,
        existingSession.sessionId,
        existingSession.session,
        now,
      );
    }
    return jsonResponse({ success: false, error: "Scanner auth storage unavailable" }, 503);
  }

  const sessionId = deps.createSessionId
    ? await deps.createSessionId()
    : await defaultCreateToken();
  let payload: ConsumedScannerTokenClaim;

  try {
    const consumeTokenClaimForRequest = deps.consumeTokenClaim ?? consumeScannerTokenClaim;
    payload = await consumeTokenClaimForRequest(db, { token, sessionId, nowMs: now });
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    const existingSession = await readScannerSession(request, kv);
    if (existingSession) {
      return refreshScannerSession(
        request,
        kv,
        existingSession.sessionId,
        existingSession.session,
        now,
      );
    }
    return jsonResponse({ success: false, error: "Token invalid or expired" }, 401);
  }

  const session: ScannerSessionPayload = {
    adminId: payload.adminId,
    adminName: payload.adminName,
    createdAt: now,
    lastSeenAt: now,
    claimTokenHash: payload.tokenHash,
  };

  await kv.put(await getScannerSessionKey(sessionId), JSON.stringify(session), {
    expirationTtl: SCANNER_SESSION_TTL_SECONDS,
  });

  return jsonResponse(
    { success: true, valid: true, adminName: payload.adminName },
    200,
    {
      "Set-Cookie": buildScannerSessionCookie(
        sessionId,
        SCANNER_SESSION_TTL_SECONDS,
        { secure: shouldUseSecureCookie(request) },
      ),
    },
  );
}

export const Route = createFileRoute("/api/scanner-token")({
  server: {
    handlers: {
      /**
       * POST -- Generate scanner token. Requires admin session.
       */
      POST: async ({ request }) => {
        return handleCreateScannerToken(request);
      },

      /**
       * GET -- Verify and claim a scanner token.
       */
      GET: async ({ request }) => {
        return handleExchangeScannerToken(request);
      },
    },
  },
});
