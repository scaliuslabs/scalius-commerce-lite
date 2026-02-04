// src/pages/api/admin/rbac/user-permissions.ts
// POST - Set a permission override for a user
// DELETE - Remove a permission override

import type { APIRoute } from "astro";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { user } from "@/db/schema";
import {
  hasPermission,
  setUserPermissionOverride,
  removeUserPermissionOverride,
} from "@/lib/rbac/helpers";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const setOverrideSchema = z.object({
  userId: z.string().min(1),
  permission: z.string().min(1),
  granted: z.boolean(),
});

const removeOverrideSchema = z.object({
  userId: z.string().min(1),
  permission: z.string().min(1),
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
    const data = setOverrideSchema.parse(body);

    // Prevent self-modification
    if (data.userId === currentUserId) {
      return new Response(
        JSON.stringify({ error: "Cannot modify your own permissions" }),
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

    // Cannot modify super admin's permissions
    if (targetUser[0].isSuperAdmin) {
      return new Response(
        JSON.stringify({ error: "Cannot modify super admin's permissions" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Set the permission override
    try {
      await setUserPermissionOverride(db, data.userId, data.permission, data.granted, currentUserId);
    } catch (error: any) {
      if (error.message?.includes("not found")) {
        return new Response(
          JSON.stringify({ error: "Permission not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      throw error;
    }

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
    console.error("Error setting permission override:", error);
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
    const data = removeOverrideSchema.parse(body);

    // Prevent self-modification
    if (data.userId === currentUserId) {
      return new Response(
        JSON.stringify({ error: "Cannot modify your own permissions" }),
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

    // Cannot modify super admin's permissions
    if (targetUser[0].isSuperAdmin) {
      return new Response(
        JSON.stringify({ error: "Cannot modify super admin's permissions" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Remove the permission override
    await removeUserPermissionOverride(db, data.userId, data.permission);

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
    console.error("Error removing permission override:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
