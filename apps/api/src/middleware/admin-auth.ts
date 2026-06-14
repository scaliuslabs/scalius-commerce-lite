// src/server/middleware/admin-auth.ts
import type { MiddlewareHandler } from "hono";
import { extractTokenFromHeader, verifyToken, refreshTokenIfNeeded } from "../utils/jwt";
import { getAuth } from "@scalius/core/auth";
import { getUserPermissions } from "@scalius/core/auth/rbac/helpers";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { UnauthorizedError, ForbiddenError } from "../utils/api-error";
import {
    SCANNER_COOKIE_NAME,
    getScannerSessionKey,
    isAllowedScannerApiRequest,
    parseCookie,
    type ScannerSessionPayload,
} from "@scalius/shared/scanner-auth";

interface User {
    id: string;
    email: string;
    name: string;
    role: string;
    twoFactorEnabled?: boolean;
    [key: string]: unknown;
}

interface Session {
    id: string;
    twoFactorVerified?: boolean | null;
    [key: string]: unknown;
}

interface ScannerKv {
    get(key: string): Promise<string | null>;
}

function normalizeAdminPath(url: string): string {
    const pathname = new URL(url).pathname;
    return pathname.startsWith("/api/v1") ? pathname : `/api/v1${pathname}`;
}

function isTwoFactorCompletionRequest(pathname: string, method: string): boolean {
    return (
        (method === "GET" && pathname === "/api/v1/admin/auth/2fa/info") ||
        (method === "POST" && pathname === "/api/v1/admin/auth/2fa/verify") ||
        (method === "POST" && pathname === "/api/v1/admin/auth/2fa/complete-verification")
    );
}

/**
 * Admin Authentication & RBAC middleware for Hono
 *
 * This perfectly decouples the API from Astro's SSR middleware.
 * It accepts EITHER a Better Auth session cookie (from the Dashboard frontend)
 * OR a JWT Bearer token via Authorization header (for decoupled mobile/external apps).
 */
export const adminAuthMiddleware: MiddlewareHandler = async (c, next) => {
    let user: User | null = null;
    let session: Session | null = null;

    // 1. Try Better Auth Session Cookie
    try {
        const auth = getAuth(c.env);
        const sessionResult = await auth.api.getSession({
            headers: c.req.raw.headers,
            query: { disableCookieCache: true },
        });
        if (sessionResult?.user) {
            user = sessionResult.user as User;
            session = (sessionResult.session ?? null) as Session | null;
        }
    } catch (error: unknown) {
        console.warn("[AdminAuth] Session verification failed:", error instanceof Error ? error.message : "Unknown error");
    }

    // 2. Try JWT Bearer Token
    if (!user) {
        try {
            const authHeader = c.req.header("Authorization") || null;
            const token = extractTokenFromHeader(authHeader);

            if (token) {
                user = (await verifyToken(token, { JWT_SECRET: c.env.JWT_SECRET, CACHE: c.env.CACHE })) as User;

                // Refresh token if needed
                const refreshedToken = await refreshTokenIfNeeded(token, 5, { JWT_SECRET: c.env.JWT_SECRET, CACHE: c.env.CACHE });
                if (refreshedToken !== token) {
                    c.header("X-New-Token", refreshedToken);
                }
            }
        } catch (error: unknown) {
            console.warn("[AdminAuth] JWT verification failed:", error instanceof Error ? error.message : "Unknown error");
        }
    }

    // 3. Try Scanner Session Cookie (for warehouse scanner app)
    if (!user) {
        try {
            const sessionId = parseCookie(c.req.header("Cookie"), SCANNER_COOKIE_NAME);
            const kv = (c.env as Record<string, unknown>).CACHE as ScannerKv | undefined;
            if (sessionId && kv) {
                const raw = await kv.get(await getScannerSessionKey(sessionId));
                if (raw) {
                    const payload = JSON.parse(raw) as ScannerSessionPayload;
                    // Scanner sessions are limited principals. Use a synthetic ID so they
                    // never inherit the creating admin's role or super-admin status.
                    user = {
                        id: `scanner:${payload.adminId || "unknown"}`,
                        email: "scanner@system",
                        name: payload.adminName || "Scanner",
                        role: "scanner",
                        _isScannerSession: true,
                    };
                }
            }
        } catch (error: unknown) {
            console.warn("[AdminAuth] Scanner session verification failed:", error instanceof Error ? error.message : "Unknown error");
        }
    }

    // If all methods fail, log and return 401
    if (!user) {
        console.warn("[AdminAuth] All auth methods failed for:", c.req.path);
        throw new UnauthorizedError("Admin access required. Please provide a valid authentication token or session cookie.");
    }

    // Inject user into Hono context
    c.set("user", user);
    if (session) {
        c.set("session", session);
    }

    // Scanner session — restrict to the exact scanner workflow endpoints only.
    if ((user as Record<string, unknown>)._isScannerSession) {
        const pathname = normalizeAdminPath(c.req.url);
        if (!isAllowedScannerApiRequest(pathname, c.req.method)) {
            throw new ForbiddenError("Scanner sessions can only access scanner inventory endpoints");
        }
        // Skip full RBAC check — scanner has implicit permission only for the allowlisted endpoints.
        await next();
        return;
    }

    const pathname = normalizeAdminPath(c.req.url);
    const method = c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

    if (
        user.twoFactorEnabled === true &&
        session?.twoFactorVerified !== true &&
        !isTwoFactorCompletionRequest(pathname, method)
    ) {
        throw new ForbiddenError("Two-factor verification required");
    }

    // 4. Admin & RBAC Validation
    const db = c.get("db");
    // getUserPermissions already checks isSuperAdmin internally and returns ALL
    // permissions for super admins — no need for a separate isSuperAdmin() query.
    const userPerms = await getUserPermissions(db, user.id);

    // Gate: must have at least one RBAC permission (super admins get all).
    // Do NOT fall back to legacy user.role check — RBAC is the source of truth.
    const hasAdminAccess = userPerms.size > 0;

    if (!hasAdminAccess) {
        throw new ForbiddenError("Admin access required");
    }

    // 4. Fine-grained Route Permissions mapped from Astro routes configuration
    // getRoutePermission expects paths like "/api/v1/admin/categories"
    const routePermission = getRoutePermission(pathname, method);

    if (!routePermission) {
        console.warn("[AdminAuth] Missing RBAC route mapping:", method, pathname);
        throw new ForbiddenError("This admin endpoint is not configured for RBAC");
    }

    let hasRequiredPermission = false;

    if (routePermission.permission) {
        hasRequiredPermission = userPerms.has(routePermission.permission);
    } else if (routePermission.anyOf) {
        hasRequiredPermission = routePermission.anyOf.some((p: string) => userPerms.has(p));
    } else if (routePermission.allOf) {
        hasRequiredPermission = routePermission.allOf.every((p: string) => userPerms.has(p));
    }

    if (!hasRequiredPermission) {
        throw new ForbiddenError("You do not have permission to perform this action");
    }

    // Passed all authentication and authorization checks
    return next();
};
