// src/pages/api/admin/rbac/roles.ts
// GET - List all roles with permissions
// POST - Create a new role

import type { APIRoute } from "astro";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { roles, rolePermissions, permissions } from "@/db/schema";
import { hasPermission, getAllRolesWithPermissions, clearAllPermissionCache } from "@/lib/rbac/helpers";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const createRoleSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, "Name must be lowercase alphanumeric with underscores"),
  displayName: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).default([]),
});

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

    // Check permission
    const canManageRoles = await hasPermission(db, userId, PERMISSIONS.TEAM_MANAGE_ROLES);
    const canViewTeam = await hasPermission(db, userId, PERMISSIONS.TEAM_VIEW);

    if (!canManageRoles && !canViewTeam) {
      return new Response(
        JSON.stringify({ error: "Forbidden", message: "Permission denied" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get all roles with their permissions
    const rolesWithPermissions = await getAllRolesWithPermissions(db);

    return new Response(
      JSON.stringify({ roles: rolesWithPermissions }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error fetching roles:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const userId = locals.user?.id;
    if (!userId) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const db = getDb(locals.runtime?.env);

    // Check permission
    const canManageRoles = await hasPermission(db, userId, PERMISSIONS.TEAM_MANAGE_ROLES);
    if (!canManageRoles) {
      return new Response(
        JSON.stringify({ error: "Forbidden", message: "Permission denied" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json();
    const data = createRoleSchema.parse(body);

    // Check if role name already exists
    const existingRole = await db
      .select()
      .from(roles)
      .where(eq(roles.name, data.name))
      .limit(1);

    if (existingRole.length > 0) {
      return new Response(
        JSON.stringify({ error: "A role with this name already exists" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Create the role
    const roleId = crypto.randomUUID();
    await db.insert(roles).values({
      id: roleId,
      name: data.name,
      displayName: data.displayName,
      description: data.description || null,
      isSystem: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Add permissions to the role if any
    if (data.permissions.length > 0) {
      // Get permission IDs
      const permRecords = await db
        .select({ id: permissions.id, name: permissions.name })
        .from(permissions)
        .where(inArray(permissions.name, data.permissions));

      // Insert role-permission mappings
      for (const perm of permRecords) {
        await db.insert(rolePermissions).values({
          id: crypto.randomUUID(),
          roleId,
          permissionId: perm.id,
          createdAt: new Date(),
        });
      }
    }

    // Clear all permission caches since role permissions changed
    clearAllPermissionCache();

    return new Response(
      JSON.stringify({
        success: true,
        role: {
          id: roleId,
          name: data.name,
          displayName: data.displayName,
          description: data.description,
          isSystem: false,
          permissions: data.permissions,
        },
      }),
      { status: 201, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({ error: "Validation error", details: error.errors }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    console.error("Error creating role:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
