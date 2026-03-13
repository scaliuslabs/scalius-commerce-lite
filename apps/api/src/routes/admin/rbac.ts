// src/server/routes/admin/rbac.ts
// Admin OpenAPI routes for RBAC (roles, permissions, user roles).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, inArray, and } from "drizzle-orm";
import { roles, rolePermissions, permissions, userRoles, user } from "@scalius/database/schema";
import {
    hasPermission,
    getAllRolesWithPermissions,
    clearAllPermissionCache,
    assignRoleToUser,
    removeRoleFromUser,
    setUserPermissionOverride,
    removeUserPermissionOverride,
    getUserPermissionContext,
    getRolePermissions
} from "@scalius/core/auth/rbac/helpers";
import { PERMISSIONS, getPermissionsByCategory } from "@scalius/core/auth/rbac/permissions";

const app = new OpenAPIHono();

// -- Validation Schemas --

const createRoleSchema = z.object({
    name: z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, "Name must be lowercase alphanumeric with underscores"),
    displayName: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    permissions: z.array(z.string()).default([])
});

const updateRoleSchema = z.object({
    displayName: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    permissions: z.array(z.string()).optional()
});

const userRoleSchema = z.object({
    userId: z.string().min(1),
    roleId: z.string().min(1)
});

const setOverrideSchema = z.object({
    userId: z.string().min(1),
    permission: z.string().min(1),
    granted: z.boolean()
});

const removeOverrideSchema = z.object({
    userId: z.string().min(1),
    permission: z.string().min(1)
});

// ── List Roles ──

const listRolesRoute = createRoute({
    method: "get",
    path: "/roles",
    tags: ["Admin - RBAC"],
    summary: "List all roles with permissions",
    responses: {
        200: { description: "Role list"  }
    }
});

app.openapi(listRolesRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES);
        const canViewTeam = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_VIEW);

        if (!canManageRoles && !canViewTeam) {
            return c.json({ error: "Forbidden", message: "Permission denied" }, 403);
        }

        const rolesWithPermissions = await getAllRolesWithPermissions(db);
        return c.json({ roles: rolesWithPermissions }, 200);
    } catch (error) {
        console.error("Error fetching roles:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── Create Role ──

const createRoleRoute = createRoute({
    method: "post",
    path: "/roles",
    tags: ["Admin - RBAC"],
    summary: "Create a new role",
    request: {
        body: { content: { "application/json": { schema: createRoleSchema } } }
    },
    responses: {
        201: { description: "Role created"  }
    }
});

app.openapi(createRoleRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES);
        if (!canManageRoles) {
            return c.json({ error: "Forbidden", message: "Permission denied" }, 403);
        }

        const data = c.req.valid("json");

        const existingRole = await db.select().from(roles).where(eq(roles.name, data.name)).limit(1);
        if (existingRole.length > 0) {
            return c.json({ error: "A role with this name already exists" }, 400);
        }

        const roleId = crypto.randomUUID();
        await db.insert(roles).values({
            id: roleId,
            name: data.name,
            displayName: data.displayName,
            description: data.description || null,
            isSystem: false,
            createdAt: new Date(),
            updatedAt: new Date()
        });

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
                    createdAt: new Date()
                });
            }
        }

        clearAllPermissionCache();

        return c.json({
            success: true,
            role: {
                id: roleId,
                name: data.name,
                displayName: data.displayName,
                description: data.description,
                isSystem: false,
                permissions: data.permissions
            }
        }, 201);
    } catch (error: any) {
        console.error("Error creating role:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── Get Role ──

const getRoleRoute = createRoute({
    method: "get",
    path: "/roles/{id}",
    tags: ["Admin - RBAC"],
    summary: "Get a single role with permissions",
    responses: {
        200: { description: "Role details"  }
    }
});

app.openapi(getRoleRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");
        const { id: roleId } = c.req.valid("param");

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES);
        const canViewTeam = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_VIEW);

        if (!canManageRoles && !canViewTeam) {
            return c.json({ error: "Forbidden", message: "Permission denied" }, 403);
        }

        const role = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);

        if (role.length === 0) {
            return c.json({ error: "Role not found" }, 404);
        }

        const perms = await getRolePermissions(db, roleId);

        return c.json({
            role: {
                ...role[0],
                permissions: perms
            }
        }, 200);
    } catch (error) {
        console.error("Error fetching role:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── Update Role ──

const updateRoleRoute = createRoute({
    method: "put",
    path: "/roles/{id}",
    tags: ["Admin - RBAC"],
    summary: "Update a role",
    request: {
        
        body: { content: { "application/json": { schema: updateRoleSchema } } }
    },
    responses: {
        200: { description: "Role updated"  }
    }
});

app.openapi(updateRoleRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");
        const { id: roleId } = c.req.valid("param");

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES);
        if (!canManageRoles) {
            return c.json({ error: "Forbidden", message: "Permission denied" }, 403);
        }

        const existingRole = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);

        if (existingRole.length === 0) {
            return c.json({ error: "Role not found" }, 404);
        }

        const role = existingRole[0];
        const data = c.req.valid("json");

        if (data.displayName || data.description !== undefined) {
            await db
                .update(roles)
                .set({
                    ...(data.displayName && { displayName: data.displayName }),
                    ...(data.description !== undefined && { description: data.description }),
                    updatedAt: new Date()
                })
                .where(eq(roles.id, roleId));
        }

        if (data.permissions !== undefined) {
            if (role.isSystem) {
                return c.json({ error: "Cannot modify permissions of system roles" }, 400);
            }

            await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));

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
                        createdAt: new Date()
                    });
                }
            }
        }

        clearAllPermissionCache();

        const updatedRole = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
        const updatedPerms = await getRolePermissions(db, roleId);

        return c.json({
            success: true,
            role: {
                ...updatedRole[0],
                permissions: updatedPerms
            }
        }, 200);
    } catch (error: any) {
        console.error("Error updating role:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── Delete Role ──

const deleteRoleRoute = createRoute({
    method: "delete",
    path: "/roles/{id}",
    tags: ["Admin - RBAC"],
    summary: "Delete a role",
    responses: {
        200: { description: "Role deleted"  }
    }
});

app.openapi(deleteRoleRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");
        const { id: roleId } = c.req.valid("param");

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES);
        if (!canManageRoles) {
            return c.json({ error: "Forbidden", message: "Permission denied" }, 403);
        }

        const existingRole = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);

        if (existingRole.length === 0) {
            return c.json({ error: "Role not found" }, 404);
        }

        const role = existingRole[0];

        if (role.isSystem) {
            return c.json({ error: "Cannot delete system roles" }, 400);
        }

        const usersWithRole = await db
            .select()
            .from(userRoles)
            .where(eq(userRoles.roleId, roleId))
            .limit(1);

        if (usersWithRole.length > 0) {
            return c.json({ error: "Cannot delete role that is assigned to users" }, 400);
        }

        await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
        await db.delete(roles).where(eq(roles.id, roleId));

        clearAllPermissionCache();

        return c.json({ success: true }, 200);
    } catch (error) {
        console.error("Error deleting role:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── Assign Role to User ──

const assignRoleRoute = createRoute({
    method: "post",
    path: "/user-roles",
    tags: ["Admin - RBAC"],
    summary: "Assign a role to a user",
    request: {
        body: { content: { "application/json": { schema: userRoleSchema } } }
    },
    responses: {
        201: { description: "Role assigned"  }
    }
});

app.openapi(assignRoleRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES);
        if (!canManageRoles) {
            return c.json({ error: "Forbidden", message: "Permission denied" }, 403);
        }

        const data = c.req.valid("json");

        if (data.userId === sessionUser.id) {
            return c.json({ error: "Cannot modify your own roles" }, 400);
        }

        const targetUser = await db.select().from(user).where(eq(user.id, data.userId)).limit(1);
        if (targetUser.length === 0) {
            return c.json({ error: "User not found" }, 404);
        }

        if (targetUser[0].isSuperAdmin) {
            return c.json({ error: "Cannot modify super admin's roles" }, 400);
        }

        const role = await db.select().from(roles).where(eq(roles.id, data.roleId)).limit(1);
        if (role.length === 0) {
            return c.json({ error: "Role not found" }, 404);
        }

        const existingAssignment = await db
            .select()
            .from(userRoles)
            .where(and(eq(userRoles.userId, data.userId), eq(userRoles.roleId, data.roleId)))
            .limit(1);

        if (existingAssignment.length > 0) {
            return c.json({ error: "User already has this role" }, 400);
        }

        await assignRoleToUser(db, data.userId, data.roleId, sessionUser.id);

        return c.json({ success: true }, 201);
    } catch (error: any) {
        console.error("Error assigning role:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── Remove Role from User ──

const removeRoleRoute = createRoute({
    method: "delete",
    path: "/user-roles",
    tags: ["Admin - RBAC"],
    summary: "Remove a role from a user",
    request: {
        body: { content: { "application/json": { schema: userRoleSchema } } }
    },
    responses: {
        200: { description: "Role removed"  }
    }
});

app.openapi(removeRoleRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES);
        if (!canManageRoles) {
            return c.json({ error: "Forbidden", message: "Permission denied" }, 403);
        }

        const data = c.req.valid("json");

        if (data.userId === sessionUser.id) {
            return c.json({ error: "Cannot modify your own roles" }, 400);
        }

        const targetUser = await db.select().from(user).where(eq(user.id, data.userId)).limit(1);
        if (targetUser.length === 0) {
            return c.json({ error: "User not found" }, 404);
        }

        if (targetUser[0].isSuperAdmin) {
            return c.json({ error: "Cannot modify super admin's roles" }, 400);
        }

        await removeRoleFromUser(db, data.userId, data.roleId);

        return c.json({ success: true }, 200);
    } catch (error: any) {
        console.error("Error removing role:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── Set Permission Override ──

const setOverrideRoute = createRoute({
    method: "post",
    path: "/user-permissions",
    tags: ["Admin - RBAC"],
    summary: "Set a permission override for a user",
    request: {
        body: { content: { "application/json": { schema: setOverrideSchema } } }
    },
    responses: {
        200: { description: "Override set"  }
    }
});

app.openapi(setOverrideRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES);
        if (!canManageRoles) {
            return c.json({ error: "Forbidden", message: "Permission denied" }, 403);
        }

        const data = c.req.valid("json");

        if (data.userId === sessionUser.id) {
            return c.json({ error: "Cannot modify your own permissions" }, 400);
        }

        const targetUser = await db.select().from(user).where(eq(user.id, data.userId)).limit(1);
        if (targetUser.length === 0) {
            return c.json({ error: "User not found" }, 404);
        }

        if (targetUser[0].isSuperAdmin) {
            return c.json({ error: "Cannot modify super admin's permissions" }, 400);
        }

        try {
            await setUserPermissionOverride(db, data.userId, data.permission, data.granted, sessionUser.id);
        } catch (error: any) {
            if (error.message?.includes("not found")) {
                return c.json({ error: "Permission not found" }, 404);
            }
            throw error;
        }

        return c.json({ success: true }, 200);
    } catch (error: any) {
        console.error("Error setting permission override:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── Remove Permission Override ──

const removeOverrideRoute = createRoute({
    method: "delete",
    path: "/user-permissions",
    tags: ["Admin - RBAC"],
    summary: "Remove a permission override",
    request: {
        body: { content: { "application/json": { schema: removeOverrideSchema } } }
    },
    responses: {
        200: { description: "Override removed"  }
    }
});

app.openapi(removeOverrideRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES);
        if (!canManageRoles) {
            return c.json({ error: "Forbidden", message: "Permission denied" }, 403);
        }

        const data = c.req.valid("json");

        if (data.userId === sessionUser.id) {
            return c.json({ error: "Cannot modify your own permissions" }, 400);
        }

        const targetUser = await db.select().from(user).where(eq(user.id, data.userId)).limit(1);
        if (targetUser.length === 0) {
            return c.json({ error: "User not found" }, 404);
        }

        if (targetUser[0].isSuperAdmin) {
            return c.json({ error: "Cannot modify super admin's permissions" }, 400);
        }

        await removeUserPermissionOverride(db, data.userId, data.permission);

        return c.json({ success: true }, 200);
    } catch (error: any) {
        console.error("Error removing permission override:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── List Permissions ──

const listPermissionsRoute = createRoute({
    method: "get",
    path: "/permissions",
    tags: ["Admin - RBAC"],
    summary: "List all available permissions",
    responses: {
        200: { description: "Permissions list"  }
    }
});

app.openapi(listPermissionsRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES);
        const canViewTeam = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_VIEW);

        if (!canManageRoles && !canViewTeam) {
            return c.json({ error: "Forbidden", message: "Permission denied" }, 403);
        }

        const allPermissions = await db.select().from(permissions);
        const groupedPermissions = getPermissionsByCategory();

        return c.json({
            permissions: allPermissions,
            grouped: groupedPermissions
        }, 200);
    } catch (error) {
        console.error("Error fetching permissions:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── My Permissions ──

const myPermissionsRoute = createRoute({
    method: "get",
    path: "/my-permissions",
    tags: ["Admin - RBAC"],
    summary: "Get current user's permission context",
    responses: {
        200: { description: "User permission context"  }
    }
});

app.openapi(myPermissionsRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");

        const context = await getUserPermissionContext(db, sessionUser.id);

        if (!context) {
            return c.json({ error: "User not found" }, 404);
        }

        return c.json({
            userId: context.userId,
            isSuperAdmin: context.isSuperAdmin,
            roles: context.roles,
            permissions: Array.from(context.effectivePermissions),
            overrides: context.overrides
        }, 200);
    } catch (error) {
        console.error("Error fetching user permissions:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

export { app as adminRbacRoutes };
