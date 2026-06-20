// src/db/schema/auth.ts
// Better Auth tables: user, session, account, verification, twoFactor.

import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";

export const user = sqliteTable("user", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" })
        .notNull()
        .default(false),
    image: text("image"),
    role: text("role").default("user"),
    isSuperAdmin: integer("is_super_admin", { mode: "boolean" })
        .notNull()
        .default(false),
    banned: integer("banned", { mode: "boolean" }).notNull().default(false),
    banReason: text("ban_reason"),
    banExpires: integer("ban_expires", { mode: "timestamp" }),
    twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).notNull().default(false),
    twoFactorMethod: text("two_factor_method"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("user_role_idx").on(table.role),
    index("user_super_admin_idx").on(table.isSuperAdmin),
]);

export const session = sqliteTable("session", {
    id: text("id").primaryKey(),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    impersonatedBy: text("impersonated_by"),
    twoFactorVerified: integer("two_factor_verified", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("session_user_id_idx").on(table.userId),
]);

export const account = sqliteTable("account", {
    id: text("id").primaryKey(),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    password: text("password"),
    idToken: text("id_token"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("account_user_id_idx").on(table.userId),
]);

export const verification = sqliteTable("verification", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("verification_identifier_idx").on(table.identifier),
]);

export const twoFactor = sqliteTable("two_factor", {
    id: text("id").primaryKey(),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: integer("verified", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("two_factor_user_id_idx").on(table.userId),
]);

export const adminSetupClaims = sqliteTable("admin_setup_claims", {
    singletonKey: text("singleton_key").primaryKey(),
    status: text("status", { enum: ["processing", "completed", "failed"] }).notNull().default("processing"),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    completedUserId: text("completed_user_id").references(() => user.id, { onDelete: "set null" }),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("admin_setup_claims_status_claim_idx").on(table.status, table.claimExpiresAt),
]);

export const adminSetupRateLimits = sqliteTable("admin_setup_rate_limits", {
    key: text("key").primaryKey(),
    attempts: integer("attempts").notNull().default(0),
    windowExpiresAt: integer("window_expires_at").notNull(),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("admin_setup_rate_limits_window_idx").on(table.windowExpiresAt),
]);

export const scannerTokenClaims = sqliteTable("scanner_token_claims", {
    tokenHash: text("token_hash").primaryKey(),
    adminId: text("admin_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    adminName: text("admin_name").notNull(),
    consumedAt: integer("consumed_at"),
    consumedSessionHash: text("consumed_session_hash"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("scanner_token_claims_expires_idx").on(table.expiresAt),
    index("scanner_token_claims_admin_created_idx").on(table.adminId, table.createdAt),
    uniqueIndex("scanner_token_claims_consumed_session_hash_uq").on(table.consumedSessionHash),
]);

export type User = InferSelectModel<typeof user>;
export type Session = InferSelectModel<typeof session>;
export type Account = InferSelectModel<typeof account>;
export type Verification = InferSelectModel<typeof verification>;
export type TwoFactor = InferSelectModel<typeof twoFactor>;
export type AdminSetupClaim = InferSelectModel<typeof adminSetupClaims>;
export type AdminSetupRateLimit = InferSelectModel<typeof adminSetupRateLimits>;
export type ScannerTokenClaim = InferSelectModel<typeof scannerTokenClaims>;
