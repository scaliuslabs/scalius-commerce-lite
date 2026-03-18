// src/server/middleware/admin-auth.ts
import type { MiddlewareHandler } from "hono";
import { extractTokenFromHeader, verifyToken, refreshTokenIfNeeded } from "../utils/jwt";
import { getAuth } from "@scalius/core/auth";
import { getUserPermissions, isSuperAdmin } from "@scalius/core/auth/rbac/helpers";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { getDb } from "@scalius/database/client";

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
        // Ignore error, fallback to JWT
    }

    // 2. Try JWT Bearer Token
    if (!user) {
        try {
            const authHeader = c.req.header("Authorization") || null;
            const token = extractTokenFromHeader(authHeader);

            if (token) {
                user = (await verifyToken(token)) as User;

                // Refresh token if needed
                const refreshedToken = refreshTokenIfNeeded(token);
                if (refreshedToken !== token) {
                    c.header("X-New-Token", refreshedToken);
                }
            }
        } catch (error: unknown) {
            // Ignore error
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
                            // Scanner token is valid — create a synthetic user with inventory permissions
                            user = {
                                id: payload.adminId || "scanner",
                                email: "scanner@system",
                                name: payload.adminName || "Scanner",
                                role: "admin",
                            };
                        }
                    }
                }
            } catch {
                // Ignore scanner token errors
            }
        }
    }

    // If all methods fail, return 401
    if (!user) {
        return c.json(
            {
                success: false,
                error: "Authentication required",
                message: "Admin access required. Please provide a valid authentication token or session cookie.",
            },
            401,
        );
    }

    // Inject user into Hono context
    c.set("user", user);

    // 3. Admin & RBAC Validation
    try {
        const db = getDb(c.env);
        const userIsSuperAdmin = await isSuperAdmin(db, user.id);
        const userPerms = await getUserPermissions(db, user.id);

        // First line of defense: must be super admin, have admin role, OR have custom delegated permissions
        const hasAdminAccess = userIsSuperAdmin || user.role === "admin" || userPerms.size > 0;

        if (user.role !== "admin" && !hasAdminAccess) {
            return c.json(
                {
                    error: "Forbidden",
                    message: "Admin access required",
                },
                403,
            );
        }

        // 4. Fine-grained Route Permissions mapped from Astro routes configuration
        // getRoutePermission expects paths like "/api/v1/admin/categories"
        const honoPathname = new URL(c.req.url).pathname;
        const pathname = honoPathname.startsWith("/api/v1") ? honoPathname : `/api/v1${honoPathname}`;
        const method = c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
        const routePermission = getRoutePermission(pathname, method);

        if (routePermission && !userIsSuperAdmin) {
            let hasRequiredPermission = false;

            if (routePermission.permission) {
                hasRequiredPermission = userPerms.has(routePermission.permission);
            } else if (routePermission.anyOf) {
                hasRequiredPermission = routePermission.anyOf.some((p: string) => userPerms.has(p));
            } else if (routePermission.allOf) {
                hasRequiredPermission = routePermission.allOf.every((p: string) => userPerms.has(p));
            }

            if (!hasRequiredPermission) {
                const requiredPermissions =
                    routePermission.permission ||
                    routePermission.anyOf?.join(" or ") ||
                    routePermission.allOf?.join(" and ");

                return c.json(
                    {
                        error: "Forbidden",
                        message: `You do not have permission to perform this action`,
                        requiredPermission: requiredPermissions,
                    },
                    403,
                );
            }
        }

        // Passed all authentication and authorization checks
        return next();
    } catch (error: unknown) {
        console.error("Admin Auth Middleware Error:", error);
        return c.json({ error: "Server error", message: "Failed to verify admin permissions" }, 500);
    }
};
