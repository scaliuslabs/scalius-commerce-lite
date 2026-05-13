// src/server/middleware/admin-auth.ts
import type { MiddlewareHandler } from "hono";
import { extractTokenFromHeader, verifyToken, refreshTokenIfNeeded } from "../utils/jwt";
import { getAuth } from "@scalius/core/auth";
import { getUserPermissions } from "@scalius/core/auth/rbac/helpers";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { UnauthorizedError, ForbiddenError } from "../utils/api-error";

interface User {
    id: string;
    email: string;
    name: string;
    role: string;
    [key: string]: unknown;
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

    // 1. Try Better Auth Session Cookie
    try {
        const auth = getAuth(c.env);
        const sessionResult = await auth.api.getSession({
            headers: c.req.raw.headers,
        });
        if (sessionResult?.user) {
            user = sessionResult.user as User;
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

    // 3. Try Scanner Token (for warehouse scanner app)
    if (!user) {
        const scannerToken = c.req.header("X-Scanner-Token");
        if (scannerToken) {
            try {
                const kv = (c.env as Record<string, unknown>).CACHE as { get: (key: string) => Promise<string | null> } | undefined;
                if (kv) {
                    const raw = await kv.get(`scanner:token:${scannerToken}`);
                    if (raw) {
                        const payload = JSON.parse(raw);
                        if (payload.claimed) {
                            // Scanner token is valid — create a synthetic user with LIMITED permissions
                            // Use a fixed non-admin ID so it doesn't inherit the creating admin's super-admin status
                            user = {
                                id: `scanner:${payload.adminId || "unknown"}`,
                                email: "scanner@system",
                                name: payload.adminName || "Scanner",
                                role: "scanner", // NOT "admin" — prevents full admin access
                                _isScannerToken: true,
                            };
                        }
                    }
                }
            } catch (error: unknown) {
                console.warn("[AdminAuth] Scanner token verification failed:", error instanceof Error ? error.message : "Unknown error");
            }
        }
    }

    // If all methods fail, log and return 401
    if (!user) {
        console.warn("[AdminAuth] All auth methods failed for:", c.req.path);
        throw new UnauthorizedError("Admin access required. Please provide a valid authentication token or session cookie.");
    }

    // Inject user into Hono context
    c.set("user", user);

    // Scanner token — restrict to inventory endpoints only
    if ((user as Record<string, unknown>)._isScannerToken) {
        const pathname = new URL(c.req.url).pathname;
        if (!pathname.includes("/inventory/")) {
            throw new ForbiddenError("Scanner tokens can only access inventory endpoints");
        }
        // Skip full RBAC check — scanner has implicit inventory permission
        await next();
        return;
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
    const honoPathname = new URL(c.req.url).pathname;
    const pathname = honoPathname.startsWith("/api/v1") ? honoPathname : `/api/v1${honoPathname}`;
    const method = c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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
