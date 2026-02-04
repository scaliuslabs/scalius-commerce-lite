// src/pages/api/admin/rbac/user-roles.ts
// POST - Assign a role to a user
// DELETE - Remove a role from a user

import type { APIRoute } from "astro";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { user, roles, userRoles } from "@/db/schema";
import {
  hasPermission,
  isSuperAdmin,
  assignRoleToUser,
  removeRoleFromUser,
  clearPermissionCache,
} from "@/lib/rbac/helpers";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const userRoleSchema = z.object({
  userId: z.string().min(1),
  roleId: z.string().min(1),
});

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const currentUserId = locals.user?.id;
    if (!currentUserId) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const db = getDb(locals.runtime?.env);

    // Check permission
    const canManageRoles = await hasPermission(db, currentUserId, PERMISSIONS.TEAM_MANAGE_ROLES);
    if (!canManageRoles) {
      return new Response(
        JSON.stringify({ error: "Forbidden", message: "Permission denied" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json();
    const data = userRoleSchema.parse(body);

    // Prevent self-modification
    if (data.userId === currentUserId) {
      return new Response(
        JSON.stringify({ error: "Cannot modify your own roles" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check if target user exists
    const targetUser = await db.select().from(user).where(eq(user.id, data.userId)).limit(1);
    if (targetUser.length === 0) {
      return new Response(
        JSON.stringify({ error: "User not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Cannot modify super admin's roles
    if (targetUser[0].isSuperAdmin) {
      return new Response(
        JSON.stringify({ error: "Cannot modify super admin's roles" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check if role exists
    const role = await db.select().from(roles).where(eq(roles.id, data.roleId)).limit(1);
    if (role.length === 0) {
      return new Response(
        JSON.stringify({ error: "Role not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check if user already has this role
    const existingAssignment = await db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, data.userId), eq(userRoles.roleId, data.roleId)))
      .limit(1);

    if (existingAssignment.length > 0) {
      return new Response(
        JSON.stringify({ error: "User already has this role" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Assign role
    await assignRoleToUser(db, data.userId, data.roleId, currentUserId);

    return new Response(
      JSON.stringify({ success: true }),
      { status: 201, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({ error: "Validation error", details: error.errors }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    console.error("Error assigning role:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  try {
    const currentUserId = locals.user?.id;
    if (!currentUserId) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const db = getDb(locals.runtime?.env);

    // Check permission
    const canManageRoles = await hasPermission(db, currentUserId, PERMISSIONS.TEAM_MANAGE_ROLES);
    if (!canManageRoles) {
      return new Response(
        JSON.stringify({ error: "Forbidden", message: "Permission denied" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json();
    const data = userRoleSchema.parse(body);

    // Prevent self-modification
    if (data.userId === currentUserId) {
      return new Response(
        JSON.stringify({ error: "Cannot modify your own roles" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check if target user exists
    const targetUser = await db.select().from(user).where(eq(user.id, data.userId)).limit(1);
    if (targetUser.length === 0) {
      return new Response(
        JSON.stringify({ error: "User not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Cannot modify super admin's roles
    if (targetUser[0].isSuperAdmin) {
      return new Response(
        JSON.stringify({ error: "Cannot modify super admin's roles" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Remove role
    await removeRoleFromUser(db, data.userId, data.roleId);

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({ error: "Validation error", details: error.errors }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    console.error("Error removing role:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
