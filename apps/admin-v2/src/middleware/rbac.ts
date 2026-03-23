/**
 * RBAC request middleware for TanStack Start.
 *
 * Runs after auth middleware. Loads user permissions from the database
 * and adds them to context for route-level access checks.
 *
 * cloudflare:workers is isolated in rbac.server.ts.
 */

import { createMiddleware } from "@tanstack/react-start";
import { authMiddleware } from "./auth";

export const rbacMiddleware = createMiddleware()
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    const user = context?.user;

    // No user = no permissions
    if (!user) {
      return next({
        context: {
          permissions: new Set<string>(),
          isSuperAdmin: false,
          hasAdminAccess: false,
        },
      });
    }

    // Dynamic import keeps cloudflare:workers out of client bundle
    const { loadUserPermissions } = await import("./rbac.server");
    const rbac = await loadUserPermissions(
      user.id,
      user.role,
    );

    return next({
      context: {
        permissions: rbac.permissions,
        isSuperAdmin: rbac.isSuperAdmin,
        hasAdminAccess: rbac.hasAdminAccess,
      },
    });
  });
