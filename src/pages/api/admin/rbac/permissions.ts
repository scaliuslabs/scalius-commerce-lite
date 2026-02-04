// src/pages/api/admin/rbac/permissions.ts
// GET - List all available permissions

import type { APIRoute } from "astro";
import { getDb } from "@/db";
import { permissions } from "@/db/schema";
import { hasPermission } from "@/lib/rbac/helpers";
import { PERMISSIONS, getPermissionsByCategory } from "@/lib/rbac/permissions";

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

    // Check permission (either TEAM_MANAGE_ROLES or TEAM_VIEW)
    const canManageRoles = await hasPermission(db, userId, PERMISSIONS.TEAM_MANAGE_ROLES);
    const canViewTeam = await hasPermission(db, userId, PERMISSIONS.TEAM_VIEW);

    if (!canManageRoles && !canViewTeam) {
      return new Response(
        JSON.stringify({ error: "Forbidden", message: "Permission denied" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get all permissions from database
    const allPermissions = await db.select().from(permissions);

    // Group by category for UI
    const groupedPermissions = getPermissionsByCategory();

    return new Response(
      JSON.stringify({
        permissions: allPermissions,
        grouped: groupedPermissions,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error fetching permissions:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
