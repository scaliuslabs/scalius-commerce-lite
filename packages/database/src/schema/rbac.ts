// src/db/schema/rbac.ts
// Role-Based Access Control tables: permissions, roles, rolePermissions, userRoles, userPermissions.

import { sqliteTable, text, integer, unique, index } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { user } from "./auth";
import { UNIX_NOW } from "./shared";

export const permissions = sqliteTable("permissions", {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    resource: text("resource").notNull(),
    action: text("action").notNull(),
    category: text("category").notNull(),
    isSensitive: integer("is_sensitive", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
});

export const roles = sqliteTable("roles", {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
});

export const rolePermissions = sqliteTable(
    "role_permissions",
    {
        id: text("id").primaryKey(),
        roleId: text("role_id")
            .notNull()
            .references(() => roles.id, { onDelete: "cascade" }),
        permissionId: text("permission_id")
            .notNull()
            .references(() => permissions.id, { onDelete: "cascade" }),
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
    },
    (table) => [
        unique("role_permission_unique").on(table.roleId, table.permissionId),
        index("role_permissions_role_idx").on(table.roleId),
        index("role_permissions_permission_idx").on(table.permissionId),
    ]
);

export const userRoles = sqliteTable(
    "user_roles",
    {
        id: text("id").primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        roleId: text("role_id")
            .notNull()
            .references(() => roles.id, { onDelete: "cascade" }),
        assignedBy: text("assigned_by").references(() => user.id, { onDelete: "set null" }),
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
    },
    (table) => [
        unique("user_role_unique").on(table.userId, table.roleId),
        index("user_roles_user_idx").on(table.userId),
        index("user_roles_role_idx").on(table.roleId),
    ]
);

export const userPermissions = sqliteTable(
    "user_permissions",
    {
        id: text("id").primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        permissionId: text("permission_id")
            .notNull()
            .references(() => permissions.id, { onDelete: "cascade" }),
        granted: integer("granted", { mode: "boolean" }).notNull(),
        assignedBy: text("assigned_by").references(() => user.id, { onDelete: "set null" }),
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
    },
    (table) => [
        unique("user_permission_unique").on(table.userId, table.permissionId),
        index("user_permissions_user_idx").on(table.userId),
        index("user_permissions_permission_idx").on(table.permissionId),
    ]
);

export type Permission = InferSelectModel<typeof permissions>;
export type Role = InferSelectModel<typeof roles>;
export type RolePermission = InferSelectModel<typeof rolePermissions>;
export type UserRole = InferSelectModel<typeof userRoles>;
export type UserPermission = InferSelectModel<typeof userPermissions>;
