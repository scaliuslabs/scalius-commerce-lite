// src/pages/api/admin/rbac/my-permissions.ts
// GET - Get current user's permissions context

import type { APIRoute } from "astro";
import { getDb } from "@/db";
import { getUserPermissionContext } from "@/lib/rbac/helpers";

export const GET: APIRoute = async ({ locals }) => {
  try {
    const userId = locals.user?.id;
    if (!userId) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const db = getDb(locals.runtime?.env);

    // Get user's permission context
    const context = await getUserPermissionContext(db, userId);

    if (!context) {
      return new Response(
        JSON.stringify({ error: "User not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Convert Set to Array for JSON serialization
    return new Response(
      JSON.stringify({
        userId: context.userId,
        isSuperAdmin: context.isSuperAdmin,
        roles: context.roles,
        permissions: Array.from(context.effectivePermissions),
        overrides: context.overrides,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error fetching user permissions:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
