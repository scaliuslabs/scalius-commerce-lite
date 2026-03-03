// src/server/routes/admin/rbac.ts
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, inArray, and } from "drizzle-orm";
import { roles, rolePermissions, permissions, userRoles, user } from "@/db/schema";
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
} from "@/lib/rbac/helpers";
import { PERMISSIONS, getPermissionsByCategory } from "@/lib/rbac/permissions";

const app = new Hono<{ Bindings: any, Variables: any }>();

// -- Validation Schemas --

const createRoleSchema = z.object({
    name: z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, "Name must be lowercase alphanumeric with underscores"),
    displayName: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    permissions: z.array(z.string()).default([]),
});

const updateRoleSchema = z.object({
    displayName: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    permissions: z.array(z.string()).optional(),
});

const userRoleSchema = z.object({
    userId: z.string().min(1),
    roleId: z.string().min(1),
});

const setOverrideSchema = z.object({
    userId: z.string().min(1),
    permission: z.string().min(1),
    granted: z.boolean(),
});

const removeOverrideSchema = z.object({
    userId: z.string().min(1),
    permission: z.string().min(1),
});


// -- Endpoints --

// GET /roles - List all roles with permissions
app.get("/roles", async (c) => {
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

// POST /roles - Create a new role
app.post("/roles", zValidator("json", createRoleSchema), async (c) => {
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
            updatedAt: new Date(),
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
                    createdAt: new Date(),
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
                permissions: data.permissions,
            },
        }, 201);
    } catch (error: any) {
        console.error("Error creating role:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// GET /roles/:id - Get a single role with permissions
app.get("/roles/:id", async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");
        const roleId = c.req.param("id");

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
                permissions: perms,
            },
        }, 200);
    } catch (error) {
        console.error("Error fetching role:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// PUT /roles/:id - Update a role
app.put("/roles/:id", zValidator("json", updateRoleSchema), async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");
        const roleId = c.req.param("id");

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
                    updatedAt: new Date(),
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
                        createdAt: new Date(),
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
                permissions: updatedPerms,
            },
        }, 200);
    } catch (error: any) {
        console.error("Error updating role:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// DELETE /roles/:id - Delete a role
app.delete("/roles/:id", async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

        const db = c.get("db");
        const roleId = c.req.param("id");

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

// POST /user-roles - Assign a role to a user
app.post("/user-roles", zValidator("json", userRoleSchema), async (c) => {
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

// DELETE /user-roles - Remove a role from a user
app.delete("/user-roles", zValidator("json", userRoleSchema), async (c) => {
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

// POST /user-permissions - Set a permission override for a user
app.post("/user-permissions", zValidator("json", setOverrideSchema), async (c) => {
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

// DELETE /user-permissions - Remove a permission override
app.delete("/user-permissions", zValidator("json", removeOverrideSchema), async (c) => {
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

// GET /permissions - List all available permissions
app.get("/permissions", async (c) => {
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
            grouped: groupedPermissions,
        }, 200);
    } catch (error) {
        console.error("Error fetching permissions:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// GET /my-permissions - Get current user's permissions context
app.get("/my-permissions", async (c) => {
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
            overrides: context.overrides,
        }, 200);
    } catch (error) {
        console.error("Error fetching user permissions:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

export { app as adminRbacRoutes };
