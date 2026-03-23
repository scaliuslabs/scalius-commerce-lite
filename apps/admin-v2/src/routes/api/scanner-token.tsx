import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

interface ScannerTokenPayload {
  adminId: string;
  adminName: string;
  createdAt: number;
  claimed: boolean;
  sessionId?: string;
}

interface ScannerUser {
  id: string;
  name?: string;
  email?: string;
}

interface ScannerSession {
  id: string;
}

interface ScannerContext {
  user?: ScannerUser;
  session?: ScannerSession;
}

interface CloudflareEnv {
  CACHE?: KVNamespace;
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

export const Route = createFileRoute("/api/scanner-token")({
  server: {
    handlers: {
      /**
       * POST -- Generate scanner token. Requires admin session.
       */
      POST: async ({ request, context }) => {
        const ctx = (context as unknown) as ScannerContext;
        const user = ctx?.user;
        const session = ctx?.session;

        if (!session || !user) {
          return jsonResponse({ success: false, error: "Authentication required" }, 401);
        }

        const kv = (env as CloudflareEnv)?.CACHE;
        if (!kv) {
          return jsonResponse({ success: false, error: "KV binding unavailable" }, 503);
        }

        const { nanoid } = await import("nanoid");
        const token = nanoid(32);
        const payload: ScannerTokenPayload = {
          adminId: user.id,
          adminName: user.name || user.email || "",
          createdAt: Date.now(),
          claimed: false,
        };

        await kv.put(`scanner:token:${token}`, JSON.stringify(payload), {
          expirationTtl: TOKEN_TTL_SECONDS,
        });

        return jsonResponse({ success: true, token });
      },

      /**
       * GET -- Verify and claim a scanner token.
       */
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const token = url.searchParams.get("token");

        if (!token) {
          return jsonResponse({ success: false, error: "Token parameter required" }, 400);
        }

        const kv = (env as CloudflareEnv)?.CACHE;
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

        // Already claimed: validate device binding
        if (payload.claimed && payload.sessionId) {
          const cookieSid = getCookie(request, COOKIE_NAME);
          if (cookieSid !== payload.sessionId) {
            return jsonResponse(
              { success: false, error: "Token already claimed by another device" },
              403,
            );
          }
          return jsonResponse(
            { success: true, valid: true, adminName: payload.adminName },
            200,
            { "Set-Cookie": buildCookieHeader(payload.sessionId, remainingTtl) },
          );
        }

        // First claim: bind to this device
        const { nanoid } = await import("nanoid");
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
      },
    },
  },
});
