// src/lib/rbac/api-protection.ts
// Higher-order function and utilities for protecting API routes with permissions

import type { APIRoute, APIContext } from "astro";
import type { Database } from "@/db";
import { hasPermission, hasAnyPermission, hasAllPermissions, isSuperAdmin } from "./helpers";
import type { PermissionName } from "./types";

/**
 * Create an unauthorized response
 */
export function unauthorizedResponse(message = "Unauthorized"): Response {
  return new Response(
    JSON.stringify({ error: "Unauthorized", message }),
    {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Create a forbidden response
 */
export function forbiddenResponse(message = "Permission denied"): Response {
  return new Response(
    JSON.stringify({ error: "Forbidden", message }),
    {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Check a single permission for an API route
 * Returns null if allowed, or a Response if denied
 */
export async function checkPermissionForApi(
  db: Database,
  userId: string | undefined,
  permission: PermissionName | string
): Promise<Response | null> {
  if (!userId) {
    return unauthorizedResponse();
  }

  const allowed = await hasPermission(db, userId, permission);
  if (!allowed) {
    return forbiddenResponse(`Required permission: ${permission}`);
  }

  return null;
}

/**
 * Check if user has any of the specified permissions
 * Returns null if allowed, or a Response if denied
 */
export async function checkAnyPermissionForApi(
  db: Database,
  userId: string | undefined,
  permissions: (PermissionName | string)[]
): Promise<Response | null> {
  if (!userId) {
    return unauthorizedResponse();
  }

  const allowed = await hasAnyPermission(db, userId, permissions);
  if (!allowed) {
    return forbiddenResponse(`Required any permission: ${permissions.join(", ")}`);
  }

  return null;
}

/**
 * Check if user has all of the specified permissions
 * Returns null if allowed, or a Response if denied
 */
export async function checkAllPermissionsForApi(
  db: Database,
  userId: string | undefined,
  permissions: (PermissionName | string)[]
): Promise<Response | null> {
  if (!userId) {
    return unauthorizedResponse();
  }

  const allowed = await hasAllPermissions(db, userId, permissions);
  if (!allowed) {
    return forbiddenResponse(`Required all permissions: ${permissions.join(", ")}`);
  }

  return null;
}

/**
 * Higher-order function to wrap an API route with permission checking
 *
 * Usage:
 * export const GET = withPermission(PERMISSIONS.PRODUCTS_VIEW, async ({ url, locals }) => {
 *   // Handler code - only runs if user has the permission
 * });
 */
export function withPermission(
  permission: PermissionName | string,
  handler: APIRoute
): APIRoute {
  return async (context: APIContext) => {
    const { getDb } = await import("@/db");
    const db = getDb(context.locals.runtime?.env);
    const userId = context.locals.user?.id;

    const error = await checkPermissionForApi(db, userId, permission);
    if (error) return error;

    return handler(context);
  };
}

/**
 * Higher-order function to wrap an API route requiring ANY of the specified permissions
 *
 * Usage:
 * export const GET = withAnyPermission(
 *   [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT],
 *   async ({ url, locals }) => {
 *     // Handler code
 *   }
 * );
 */
export function withAnyPermission(
  permissions: (PermissionName | string)[],
  handler: APIRoute
): APIRoute {
  return async (context: APIContext) => {
    const { getDb } = await import("@/db");
    const db = getDb(context.locals.runtime?.env);
    const userId = context.locals.user?.id;

    const error = await checkAnyPermissionForApi(db, userId, permissions);
    if (error) return error;

    return handler(context);
  };
}

/**
 * Higher-order function to wrap an API route requiring ALL of the specified permissions
 *
 * Usage:
 * export const DELETE = withAllPermissions(
 *   [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_DELETE],
 *   async ({ url, locals }) => {
 *     // Handler code
 *   }
 * );
 */
export function withAllPermissions(
  permissions: (PermissionName | string)[],
  handler: APIRoute
): APIRoute {
  return async (context: APIContext) => {
    const { getDb } = await import("@/db");
    const db = getDb(context.locals.runtime?.env);
    const userId = context.locals.user?.id;

    const error = await checkAllPermissionsForApi(db, userId, permissions);
    if (error) return error;

    return handler(context);
  };
}

/**
 * Higher-order function to wrap an API route that requires super admin
 *
 * Usage:
 * export const POST = withSuperAdmin(async ({ request, locals }) => {
 *   // Handler code - only runs if user is super admin
 * });
 */
export function withSuperAdmin(handler: APIRoute): APIRoute {
  return async (context: APIContext) => {
    const { getDb } = await import("@/db");
    const db = getDb(context.locals.runtime?.env);
    const userId = context.locals.user?.id;

    if (!userId) {
      return unauthorizedResponse();
    }

    const isSuper = await isSuperAdmin(db, userId);
    if (!isSuper) {
      return forbiddenResponse("Super admin access required");
    }

    return handler(context);
  };
}
