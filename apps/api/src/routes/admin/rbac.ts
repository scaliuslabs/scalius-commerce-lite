// src/server/routes/admin/rbac.ts
// Admin OpenAPI routes for RBAC (roles, permissions, user roles).

import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import { eq, inArray, and } from "drizzle-orm";
import { roles, rolePermissions, permissions, userRoles, user } from "@scalius/database/schema";
import {
    hasPermission,
    getAllRolesWithPermissions,
    clearAllPermissionCache,
    clearPermissionCacheForRole,
    assignRoleToUser,
    removeRoleFromUser,
    setUserPermissionOverride,
    removeUserPermissionOverride,
    getUserPermissionContext,
    getRolePermissions
} from "@scalius/core/auth/rbac/helpers";
import { PERMISSIONS, getPermissionsByCategory } from "@scalius/core/auth/rbac/permissions";

import { ok, created } from "../../utils/api-response";
import { UnauthorizedError, ForbiddenError, NotFoundError, ValidationError, ConflictError } from "../../utils/api-error";
import { successEnvelope, errorResponses } from "../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];

function getPermissionKv(c: { env: Env }): KVNamespace | undefined {
    return c.env.CACHE as KVNamespace | undefined;
}

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

const roleSchema = z.object({
    id: z.string(),
    name: z.string(),
    displayName: z.string(),
    description: z.string().nullable(),
    isSystem: z.boolean(),
    permissions: z.array(z.string()),
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
}).passthrough();

const listRolesRoute = createRoute({
    method: "get",
    path: "/roles",
    tags: ["Admin - RBAC"],
    summary: "List all roles with permissions",
    responses: {
        200: { description: "Role list", content: { "application/json": { schema: successEnvelope(z.object({ roles: z.array(roleSchema) })) } } },
        ...errorResponses,
    }
});

app.openapi(listRolesRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) throw new UnauthorizedError("Unauthorized");

        const db = c.get("db");
        const kv = getPermissionKv(c);

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES, kv);
        const canViewTeam = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_VIEW, kv);

        if (!canManageRoles && !canViewTeam) {
            throw new ForbiddenError("Permission denied");
        }

        const rolesWithPermissions = await getAllRolesWithPermissions(db);
        return ok(c, { roles: rolesWithPermissions });
    } catch (error: unknown) {
        console.error("Error fetching roles:", error);
        throw error;
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
        201: { description: "Role created", content: { "application/json": { schema: successEnvelope(z.object({ role: roleSchema })) } } },
        ...errorResponses,
    }
});

app.openapi(createRoleRoute, (async (c: AdminRouteContext<typeof createRoleRoute>) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) throw new UnauthorizedError("Unauthorized");

        const db = c.get("db");
        const kv = getPermissionKv(c);

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES, kv);
        if (!canManageRoles) {
            throw new ForbiddenError("Permission denied");
        }

        const data = c.req.valid("json");

        const existingRole = await db.select().from(roles).where(eq(roles.name, data.name)).limit(1);
        if (existingRole.length > 0) {
            throw new ConflictError("A role with this name already exists");
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

            if (permRecords.length > 0) {
                const inserts = permRecords.map((perm: { id: string; name: string }) =>
                    db.insert(rolePermissions).values({
                        id: crypto.randomUUID(),
                        roleId,
                        permissionId: perm.id,
                        createdAt: new Date()
                    })
                );
                await db.batch(inserts as [typeof inserts[0], ...typeof inserts]);
            }
        }

    clearAllPermissionCache();

        return created(c, {
            role: {
                id: roleId,
                name: data.name,
                displayName: data.displayName,
                description: data.description,
                isSystem: false,
                permissions: data.permissions
            }
        });
    } catch (error: unknown) {
        console.error("Error creating role:", error);
        throw error;
    }
}) as unknown as AdminRouteHandler<typeof createRoleRoute>);

// ── Get Role ──

const getRoleRoute = createRoute({
    method: "get",
    path: "/roles/{id}",
    tags: ["Admin - RBAC"],
    summary: "Get a single role with permissions",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Role details", content: { "application/json": { schema: successEnvelope(z.object({ role: roleSchema })) } } },
        ...errorResponses,
    }
});

app.openapi(getRoleRoute, (async (c: AdminRouteContext<typeof getRoleRoute>) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) throw new UnauthorizedError("Unauthorized");

        const db = c.get("db");
        const kv = getPermissionKv(c);
        const { id: roleId } = c.req.valid("param");

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES, kv);
        const canViewTeam = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_VIEW, kv);

        if (!canManageRoles && !canViewTeam) {
            throw new ForbiddenError("Permission denied");
        }

        const role = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);

        if (role.length === 0) {
            throw new NotFoundError("Role not found");
        }

        const perms = await getRolePermissions(db, roleId);

        return ok(c, {
            role: {
                ...role[0],
                permissions: perms
            }
        });
    } catch (error: unknown) {
        console.error("Error fetching role:", error);
        throw error;
    }
}) as unknown as AdminRouteHandler<typeof getRoleRoute>);

// ── Update Role ──

const updateRoleRoute = createRoute({
    method: "put",
    path: "/roles/{id}",
    tags: ["Admin - RBAC"],
    summary: "Update a role",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateRoleSchema } } }
    },
    responses: {
        200: { description: "Role updated", content: { "application/json": { schema: successEnvelope(z.object({ role: roleSchema })) } } },
        ...errorResponses,
    }
});

app.openapi(updateRoleRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) throw new UnauthorizedError("Unauthorized");

        const db = c.get("db");
        const kv = getPermissionKv(c);
        const { id: roleId } = c.req.valid("param");

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES, kv);
        if (!canManageRoles) {
            throw new ForbiddenError("Permission denied");
        }

        const existingRole = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);

        if (existingRole.length === 0) {
            throw new NotFoundError("Role not found");
        }

        const role = existingRole[0];
        if (!role) throw new NotFoundError("Role not found");
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
                throw new ValidationError("Cannot modify permissions of system roles");
            }

            await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));

            if (data.permissions.length > 0) {
                const permRecords = await db
                    .select({ id: permissions.id, name: permissions.name })
                    .from(permissions)
                    .where(inArray(permissions.name, data.permissions));

                if (permRecords.length > 0) {
                    const inserts = permRecords.map((perm: { id: string; name: string }) =>
                        db.insert(rolePermissions).values({
                            id: crypto.randomUUID(),
                            roleId,
                            permissionId: perm.id,
                            createdAt: new Date()
                        })
                    );
                    await db.batch(inserts as [typeof inserts[0], ...typeof inserts]);
                }
            }
        }

        await clearPermissionCacheForRole(db, roleId, kv);
        clearAllPermissionCache();

        const updatedRole = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
        const updatedPerms = await getRolePermissions(db, roleId);

        const roleData = updatedRole[0];
        if (!roleData) throw new NotFoundError("Role not found after update");

        return ok(c, {
            role: {
                ...roleData,
                permissions: updatedPerms
            }
        });
    } catch (error: unknown) {
        console.error("Error updating role:", error);
        throw error;
    }
});

// ── Delete Role ──

const deleteRoleRoute = createRoute({
    method: "delete",
    path: "/roles/{id}",
    tags: ["Admin - RBAC"],
    summary: "Delete a role",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Role deleted", content: { "application/json": { schema: successEnvelope(z.object({})) } } },
        ...errorResponses,
    }
});

app.openapi(deleteRoleRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) throw new UnauthorizedError("Unauthorized");

        const db = c.get("db");
        const kv = getPermissionKv(c);
        const { id: roleId } = c.req.valid("param");

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES, kv);
        if (!canManageRoles) {
            throw new ForbiddenError("Permission denied");
        }

        const existingRole = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);

        if (existingRole.length === 0) {
            throw new NotFoundError("Role not found");
        }

        const role = existingRole[0];
        if (!role) throw new NotFoundError("Role not found");

        if (role.isSystem) {
            throw new ValidationError("Cannot delete system roles");
        }

        const usersWithRole = await db
            .select()
            .from(userRoles)
            .where(eq(userRoles.roleId, roleId))
            .limit(1);

        if (usersWithRole.length > 0) {
            throw new ConflictError("Cannot delete role that is assigned to users");
        }

        await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
        await db.delete(roles).where(eq(roles.id, roleId));

    clearAllPermissionCache();

        return ok(c, {});
    } catch (error: unknown) {
        console.error("Error deleting role:", error);
        throw error;
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
        201: { description: "Role assigned", content: { "application/json": { schema: successEnvelope(z.object({})) } } },
        ...errorResponses,
    }
});

app.openapi(assignRoleRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) throw new UnauthorizedError("Unauthorized");

        const db = c.get("db");
        const kv = getPermissionKv(c);

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES, kv);
        if (!canManageRoles) {
            throw new ForbiddenError("Permission denied");
        }

        const data = c.req.valid("json");

        if (data.userId === sessionUser.id) {
            throw new ValidationError("Cannot modify your own roles");
        }

        const targetUser = await db.select().from(user).where(eq(user.id, data.userId)).limit(1);
        if (targetUser.length === 0) {
            throw new NotFoundError("User not found");
        }

        if (targetUser[0]?.isSuperAdmin) {
            throw new ValidationError("Cannot modify super admin's roles");
        }

        const role = await db.select().from(roles).where(eq(roles.id, data.roleId)).limit(1);
        if (role.length === 0) {
            throw new NotFoundError("Role not found");
        }

        const existingAssignment = await db
            .select()
            .from(userRoles)
            .where(and(eq(userRoles.userId, data.userId), eq(userRoles.roleId, data.roleId)))
            .limit(1);

        if (existingAssignment.length > 0) {
            throw new ConflictError("User already has this role");
        }

        await assignRoleToUser(db, data.userId, data.roleId, sessionUser.id, kv);

        return created(c, {});
    } catch (error: unknown) {
        console.error("Error assigning role:", error);
        throw error;
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
        200: { description: "Role removed", content: { "application/json": { schema: successEnvelope(z.object({})) } } },
        ...errorResponses,
    }
});

app.openapi(removeRoleRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) throw new UnauthorizedError("Unauthorized");

        const db = c.get("db");
        const kv = getPermissionKv(c);

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES, kv);
        if (!canManageRoles) {
            throw new ForbiddenError("Permission denied");
        }

        const data = c.req.valid("json");

        if (data.userId === sessionUser.id) {
            throw new ValidationError("Cannot modify your own roles");
        }

        const targetUser = await db.select().from(user).where(eq(user.id, data.userId)).limit(1);
        if (targetUser.length === 0) {
            throw new NotFoundError("User not found");
        }

        if (targetUser[0]?.isSuperAdmin) {
            throw new ValidationError("Cannot modify super admin's roles");
        }

        await removeRoleFromUser(db, data.userId, data.roleId, kv);

        return ok(c, {});
    } catch (error: unknown) {
        console.error("Error removing role:", error);
        throw error;
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
        200: { description: "Override set", content: { "application/json": { schema: successEnvelope(z.object({})) } } },
        ...errorResponses,
    }
});

app.openapi(setOverrideRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) throw new UnauthorizedError("Unauthorized");

        const db = c.get("db");
        const kv = getPermissionKv(c);

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES, kv);
        if (!canManageRoles) {
            throw new ForbiddenError("Permission denied");
        }

        const data = c.req.valid("json");

        if (data.userId === sessionUser.id) {
            throw new ValidationError("Cannot modify your own permissions");
        }

        const targetUser = await db.select().from(user).where(eq(user.id, data.userId)).limit(1);
        if (targetUser.length === 0) {
            throw new NotFoundError("User not found");
        }

        if (targetUser[0]?.isSuperAdmin) {
            throw new ValidationError("Cannot modify super admin's permissions");
        }

        try {
            await setUserPermissionOverride(db, data.userId, data.permission, data.granted, sessionUser.id, kv);
        } catch (error: unknown) {
            if (error instanceof Error && error.message?.includes("not found")) {
                throw new NotFoundError("Permission not found");
            }
            throw error;
        }

        return ok(c, {});
    } catch (error: unknown) {
        console.error("Error setting permission override:", error);
        throw error;
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
        200: { description: "Override removed", content: { "application/json": { schema: successEnvelope(z.object({})) } } },
        ...errorResponses,
    }
});

app.openapi(removeOverrideRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) throw new UnauthorizedError("Unauthorized");

        const db = c.get("db");
        const kv = getPermissionKv(c);

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES, kv);
        if (!canManageRoles) {
            throw new ForbiddenError("Permission denied");
        }

        const data = c.req.valid("json");

        if (data.userId === sessionUser.id) {
            throw new ValidationError("Cannot modify your own permissions");
        }

        const targetUser = await db.select().from(user).where(eq(user.id, data.userId)).limit(1);
        if (targetUser.length === 0) {
            throw new NotFoundError("User not found");
        }

        if (targetUser[0]?.isSuperAdmin) {
            throw new ValidationError("Cannot modify super admin's permissions");
        }

        await removeUserPermissionOverride(db, data.userId, data.permission, kv);

        return ok(c, {});
    } catch (error: unknown) {
        console.error("Error removing permission override:", error);
        throw error;
    }
});

// ── List Permissions ──

const listPermissionsRoute = createRoute({
    method: "get",
    path: "/permissions",
    tags: ["Admin - RBAC"],
    summary: "List all available permissions",
    responses: {
        200: { description: "Permissions list", content: { "application/json": { schema: successEnvelope(z.object({ permissions: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().nullable(), category: z.string() }).passthrough()), grouped: z.record(z.string(), z.array(z.object({ name: z.string(), description: z.string() }))) })) } } },
        ...errorResponses,
    }
});

app.openapi(listPermissionsRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) throw new UnauthorizedError("Unauthorized");

        const db = c.get("db");
        const kv = getPermissionKv(c);

        const canManageRoles = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE_ROLES, kv);
        const canViewTeam = await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_VIEW, kv);

        if (!canManageRoles && !canViewTeam) {
            throw new ForbiddenError("Permission denied");
        }

        const allPermissions = await db.select().from(permissions);
        const groupedPermissions = getPermissionsByCategory();

        return ok(c, {
            permissions: allPermissions,
            grouped: groupedPermissions
        });
    } catch (error: unknown) {
        console.error("Error fetching permissions:", error);
        throw error;
    }
});

// ── My Permissions ──

const myPermissionsRoute = createRoute({
    method: "get",
    path: "/my-permissions",
    tags: ["Admin - RBAC"],
    summary: "Get current user's permission context",
    responses: {
        200: { description: "User permission context", content: { "application/json": { schema: successEnvelope(z.object({ userId: z.string(), isSuperAdmin: z.boolean(), roles: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()), permissions: z.array(z.string()), overrides: z.object({ grants: z.array(z.string()), denials: z.array(z.string()) }) })) } } },
        ...errorResponses,
    }
});

app.openapi(myPermissionsRoute, async (c) => {
    try {
        const sessionUser = c.get("user");
        if (!sessionUser) throw new UnauthorizedError("Unauthorized");

        const db = c.get("db");
        const kv = getPermissionKv(c);

        const context = await getUserPermissionContext(db, sessionUser.id, kv);

        if (!context) {
            throw new NotFoundError("User not found");
        }

        return ok(c, {
            userId: context.userId,
            isSuperAdmin: context.isSuperAdmin,
            roles: context.roles,
            permissions: Array.from(context.effectivePermissions),
            overrides: context.overrides
        });
    } catch (error: unknown) {
        console.error("Error fetching user permissions:", error);
        throw error;
    }
});

export { app as adminRbacRoutes };
