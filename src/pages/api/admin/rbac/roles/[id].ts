// src/pages/api/admin/rbac/roles/[id].ts
// GET - Get a single role with permissions
// PUT - Update a role
// DELETE - Delete a role

import type { APIRoute } from "astro";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { roles, rolePermissions, permissions, userRoles } from "@/db/schema";
import { hasPermission, getRolePermissions, clearAllPermissionCache } from "@/lib/rbac/helpers";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const updateRoleSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).optional(),
});

export const GET: APIRoute = async ({ params, locals }) => {
  try {
    const userId = locals.user?.id;
    if (!userId) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const db = getDb(locals.runtime?.env);
    const roleId = params.id;

    if (!roleId) {
      return new Response(
        JSON.stringify({ error: "Role ID is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check permission
    const canManageRoles = await hasPermission(db, userId, PERMISSIONS.TEAM_MANAGE_ROLES);
    const canViewTeam = await hasPermission(db, userId, PERMISSIONS.TEAM_VIEW);

    if (!canManageRoles && !canViewTeam) {
      return new Response(
        JSON.stringify({ error: "Forbidden", message: "Permission denied" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get role
    const role = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);

    if (role.length === 0) {
      return new Response(
        JSON.stringify({ error: "Role not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get role permissions
    const perms = await getRolePermissions(db, roleId);

    return new Response(
      JSON.stringify({
        role: {
          ...role[0],
          permissions: perms,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error fetching role:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    const userId = locals.user?.id;
    if (!userId) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const db = getDb(locals.runtime?.env);
    const roleId = params.id;

    if (!roleId) {
      return new Response(
        JSON.stringify({ error: "Role ID is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check permission
    const canManageRoles = await hasPermission(db, userId, PERMISSIONS.TEAM_MANAGE_ROLES);
    if (!canManageRoles) {
      return new Response(
        JSON.stringify({ error: "Forbidden", message: "Permission denied" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get role
    const existingRole = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);

    if (existingRole.length === 0) {
      return new Response(
        JSON.stringify({ error: "Role not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const role = existingRole[0];

    // Cannot modify system roles' permissions (but can update display name/description)
    const body = await request.json();
    const data = updateRoleSchema.parse(body);

    // Update role metadata
    if (data.displayName || data.description !== undefined) {
      await db
        .update(roles)
        .set({
          ...(data.displayName && { displayName: data.displayName }),
          ...(data.description !== undefined && { description: data.description }),
          updatedAt: new Date(),
        })
        .where(eq(roles.id, roleId));
    }

    // Update permissions (only for non-system roles)
    if (data.permissions !== undefined) {
      if (role.isSystem) {
        return new Response(
          JSON.stringify({ error: "Cannot modify permissions of system roles" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      // Delete existing permissions
      await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));

      // Add new permissions
      if (data.permissions.length > 0) {
        const permRecords = await db
          .select({ id: permissions.id, name: permissions.name })
          .from(permissions)
          .where(inArray(permissions.name, data.permissions));

        for (const perm of permRecords) {
          await db.insert(rolePermissions).values({
            id: crypto.randomUUID(),
            roleId,
            permissionId: perm.id,
            createdAt: new Date(),
          });
        }
      }
    }

    // Clear all permission caches
    clearAllPermissionCache();

    // Get updated role with permissions
    const updatedRole = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    const updatedPerms = await getRolePermissions(db, roleId);

    return new Response(
      JSON.stringify({
        success: true,
        role: {
          ...updatedRole[0],
          permissions: updatedPerms,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({ error: "Validation error", details: error.errors }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    console.error("Error updating role:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    const userId = locals.user?.id;
    if (!userId) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const db = getDb(locals.runtime?.env);
    const roleId = params.id;

    if (!roleId) {
      return new Response(
        JSON.stringify({ error: "Role ID is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check permission
    const canManageRoles = await hasPermission(db, userId, PERMISSIONS.TEAM_MANAGE_ROLES);
    if (!canManageRoles) {
      return new Response(
        JSON.stringify({ error: "Forbidden", message: "Permission denied" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get role
    const existingRole = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);

    if (existingRole.length === 0) {
      return new Response(
        JSON.stringify({ error: "Role not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const role = existingRole[0];

    // Cannot delete system roles
    if (role.isSystem) {
      return new Response(
        JSON.stringify({ error: "Cannot delete system roles" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check if any users have this role
    const usersWithRole = await db
      .select()
      .from(userRoles)
      .where(eq(userRoles.roleId, roleId))
      .limit(1);

    if (usersWithRole.length > 0) {
      return new Response(
        JSON.stringify({ error: "Cannot delete role that is assigned to users" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Delete role permissions first (should cascade, but being explicit)
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));

    // Delete role
    await db.delete(roles).where(eq(roles.id, roleId));

    // Clear all permission caches
    clearAllPermissionCache();

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error deleting role:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
