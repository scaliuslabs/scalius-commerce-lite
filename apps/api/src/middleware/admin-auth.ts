// src/server/middleware/admin-auth.ts
import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { getAuth } from "@scalius/core/auth";
import { getUserPermissions } from "@scalius/core/auth/rbac/helpers";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { user as userTable } from "@scalius/database/schema";
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
    mustChangePassword?: boolean;
    mustEnrollTwoFactor?: boolean;
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

const BETTER_AUTH_SESSION_COOKIE_NAMES = [
    "better-auth.session_token",
    "__Secure-better-auth.session_token",
] as const;

function normalizeAdminPath(url: string): string {
    const pathname = new URL(url).pathname;
    return pathname.startsWith("/api/v1") ? pathname : `/api/v1${pathname}`;
}

function hasNamedCookie(
    cookieHeader: string | undefined,
    name: string,
): boolean {
    return Boolean(parseCookie(cookieHeader, name));
}

function hasBetterAuthSessionCookie(cookieHeader: string | undefined): boolean {
    return BETTER_AUTH_SESSION_COOKIE_NAMES.some((name) =>
        hasNamedCookie(cookieHeader, name),
    );
}

function isTwoFactorCompletionRequest(
    pathname: string,
    method: string,
): boolean {
    return (
        (method === "GET" && pathname === "/api/v1/admin/auth/2fa/info") ||
        (method === "POST" && pathname === "/api/v1/admin/auth/2fa/verify") ||
        (method === "POST" &&
            pathname === "/api/v1/admin/auth/2fa/complete-verification") ||
        (method === "POST" && pathname === "/api/v1/admin/auth/2fa/method")
    );
}

function isPasswordOnboardingRequest(
    pathname: string,
    method: string,
): boolean {
    return (
        method === "POST" && pathname === "/api/v1/admin/auth/change-password"
    );
}

function isTwoFactorOnboardingRequest(
    pathname: string,
    method: string,
): boolean {
    return (
        (method === "GET" && pathname === "/api/v1/admin/auth/2fa/info") ||
        (method === "POST" && pathname === "/api/v1/admin/auth/2fa/method")
    );
}

/**
 * Admin Authentication & RBAC middleware for Hono
 *
 * This perfectly decouples the API from Astro's SSR middleware.
 * It accepts an active Better Auth session cookie from the dashboard frontend.
 * Scanner sessions are the only non-dashboard exception and are restricted to
 * the exact scanner workflow endpoints.
 */
export const adminAuthMiddleware: MiddlewareHandler = async (c, next) => {
    let user: User | null = null;
    let session: Session | null = null;
    const cookieHeader = c.req.header("Cookie");
    const hasBetterAuthCookie = hasBetterAuthSessionCookie(cookieHeader);
    const hasScannerCookie = hasNamedCookie(cookieHeader, SCANNER_COOKIE_NAME);

    // 1. Try Better Auth Session Cookie
    if (hasBetterAuthCookie) {
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
            console.warn(
                "[AdminAuth] Session verification failed:",
                error instanceof Error ? error.message : "Unknown error",
            );
        }
    }

    // 2. Try Scanner Session Cookie (for warehouse scanner app)
    if (!user && hasScannerCookie) {
        try {
            const sessionId = parseCookie(cookieHeader, SCANNER_COOKIE_NAME);
            const kv = (c.env as Record<string, unknown>).CACHE as
                ScannerKv | undefined;
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
            console.warn(
                "[AdminAuth] Scanner session verification failed:",
                error instanceof Error ? error.message : "Unknown error",
            );
        }
    }

    // If all methods fail, keep ordinary no-cookie probes quiet but preserve
    // a warning when a presented admin/scanner cookie could not authenticate.
    if (!user) {
        if (hasBetterAuthCookie || hasScannerCookie) {
            console.warn(
                "[AdminAuth] All auth methods failed for:",
                c.req.path,
            );
        }
        throw new UnauthorizedError(
            "Admin access requires a valid dashboard session cookie.",
        );
    }

    const pathname = normalizeAdminPath(c.req.url);
    const method = c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

    // Scanner session — restrict to the exact scanner workflow endpoints only.
    if ((user as Record<string, unknown>)._isScannerSession) {
        c.set("user", user);
        if (!isAllowedScannerApiRequest(pathname, c.req.method)) {
            throw new ForbiddenError(
                "Scanner sessions can only access scanner inventory endpoints",
            );
        }
        // Skip full RBAC check — scanner has implicit permission only for the allowlisted endpoints.
        await next();
        return;
    }

    // D1 is the authority for admin onboarding gates. Better Auth session payloads
    // can be stale, and RBAC must not run until invited admins finish setup.
    const db = c.get("db");
    const liveUser = await db
        .select({
            id: userTable.id,
            email: userTable.email,
            name: userTable.name,
            role: userTable.role,
            isSuperAdmin: userTable.isSuperAdmin,
            twoFactorEnabled: userTable.twoFactorEnabled,
            mustChangePassword: userTable.mustChangePassword,
            mustEnrollTwoFactor: userTable.mustEnrollTwoFactor,
        })
        .from(userTable)
        .where(eq(userTable.id, user.id))
        .get();

    if (!liveUser) {
        throw new UnauthorizedError("Admin session user no longer exists.");
    }

    user = {
        ...user,
        id: liveUser.id,
        email: liveUser.email,
        name: liveUser.name,
        role: liveUser.role ?? user.role,
        isSuperAdmin: liveUser.isSuperAdmin,
        twoFactorEnabled: liveUser.twoFactorEnabled,
        mustChangePassword: liveUser.mustChangePassword,
        mustEnrollTwoFactor: liveUser.mustEnrollTwoFactor,
    };

    c.set("user", user);
    if (session) {
        c.set("session", session);
    }

    if (
        user.mustChangePassword === true &&
        !isPasswordOnboardingRequest(pathname, method)
    ) {
        throw new ForbiddenError("Password setup required before admin access");
    }

    if (
        user.mustEnrollTwoFactor === true &&
        user.twoFactorEnabled !== true &&
        !isTwoFactorOnboardingRequest(pathname, method)
    ) {
        throw new ForbiddenError(
            "Two-factor setup required before admin access",
        );
    }

    if (
        user.twoFactorEnabled === true &&
        session?.twoFactorVerified !== true &&
        !isTwoFactorCompletionRequest(pathname, method)
    ) {
        throw new ForbiddenError("Two-factor verification required");
    }

    // 4. Admin & RBAC Validation
    // getUserPermissions already checks isSuperAdmin internally and returns ALL
    // permissions for super admins — no need for a separate isSuperAdmin() query.
    const userPerms = await getUserPermissions(db, user.id, c.env.CACHE);

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
        console.warn(
            "[AdminAuth] Missing RBAC route mapping:",
            method,
            pathname,
        );
        throw new ForbiddenError(
            "This admin endpoint is not configured for RBAC",
        );
    }

    let hasRequiredPermission = false;

    if (routePermission.allowAnyAdmin) {
        hasRequiredPermission = true;
    } else if (routePermission.permission) {
        hasRequiredPermission = userPerms.has(routePermission.permission);
    } else if (routePermission.anyOf) {
        hasRequiredPermission = routePermission.anyOf.some((p: string) =>
            userPerms.has(p),
        );
    } else if (routePermission.allOf) {
        hasRequiredPermission = routePermission.allOf.every((p: string) =>
            userPerms.has(p),
        );
    }

    if (!hasRequiredPermission) {
        throw new ForbiddenError(
            "You do not have permission to perform this action",
        );
    }

    // Passed all authentication and authorization checks
    return next();
};
