// src/db/schema/system.ts
// System/platform tables: settings, analytics, adminFcmTokens, checkoutLanguages.

import { sqliteTable, text, integer, unique, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { user } from "./auth";

/**
 * Provider-neutral release schema authority. D1, TursoDB, and PostgreSQL
 * record the same ordered migration identities, allowing Worker readiness to
 * reject a reachable but incompatible database before serving commerce
 * traffic. Provider migration tooling owns these rows; application routes do
 * not mutate them.
 */
export const scaliusSchemaMigrations = sqliteTable(
    "scalius_schema_migrations",
    {
        version: integer("version").primaryKey(),
        name: text("name").notNull().unique(),
        sourceSha256: text("source_sha256").notNull(),
        appliedAt: integer("applied_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
    },
    (table) => [
        check("scalius_schema_migrations_version_positive", sql`${table.version} >= 1`),
        check(
            "scalius_schema_migrations_source_sha256",
            sql`length(${table.sourceSha256}) = 64`,
        ),
    ],
);

export const settings = sqliteTable(
    "settings",
    {
        id: text("id").primaryKey(),
        key: text("key").notNull(),
        value: text("value").notNull(),
        type: text("type").notNull(),
        category: text("category").notNull(),
        /** Optimistic-concurrency revision of a settings document row. */
        revision: integer("revision").notNull().default(1),
        updatedAt: integer("updated_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
        expiresAt: integer("expires_at", { mode: "timestamp" }),
    },
    (table) => [unique("settings_key_category").on(table.key, table.category)],
);

/**
 * Monotonic fence for every fact that can change checkout economics or buyer
 * eligibility. Coordinated checkout reads it with the authority snapshot and
 * validates the same revision inside the atomic order commit.
 */
export const checkoutAuthority = sqliteTable("checkout_authority", {
    id: text("id").primaryKey().default("default"),
    revision: integer("revision").notNull().default(1),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    check("checkout_authority_singleton", sql`${table.id} = 'default'`),
    check("checkout_authority_revision_positive", sql`${table.revision} >= 1`),
]);

/**
 * The store's public cache generation: one opaque random token included in
 * every public API and storefront cache key. Buyer-visible writes replace it
 * right after they commit; the API mirrors it to the `CACHE` KV namespace.
 */
export const cacheGeneration = sqliteTable("cache_generation", {
    id: text("id").primaryKey().default("default"),
    generation: text("generation").notNull(),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    check("cache_generation_singleton", sql`${table.id} = 'default'`),
]);

/**
 * Commit-ordered change clock of the dependency-validated cache (migration
 * 0093). One row. `seq` is the highest `cache_dep.seq` committed; a render
 * reads it first (`s0`). `floor` is raised when old `cache_dep` rows are
 * pruned (an entry below it is invalid). `coarse` is 1 only inside a
 * catalogue-wide rebuild batch, where every trigger advances `store` instead
 * of its own keys. Written only by the generated triggers and that batch.
 */
export const cacheClock = sqliteTable("cache_clock", {
    id: integer("id").primaryKey(),
    seq: integer("seq").notNull().default(0),
    floor: integer("floor").notNull().default(0),
    coarse: integer("coarse").notNull().default(0),
}, (table) => [
    check("cache_clock_singleton", sql`${table.id} = 1`),
    check("cache_clock_coarse_flag", sql`${table.coarse} IN (0, 1)`),
]);

/**
 * Dependency key -> clock value of its last buyer-visible change. Kept by the
 * triggers generated from `@scalius/shared/cache-deps` in the same
 * transaction as the change; `cache_dep_seq_idx` serves the frontier range scan.
 */
export const cacheDep = sqliteTable("cache_dep", {
    dep: text("dep").primaryKey(),
    seq: integer("seq").notNull(),
}, (table) => [
    index("cache_dep_seq_idx").on(table.seq),
]);

/**
 * Published storefront theme document.
 *
 * Presentation settings affect every buyer-facing route, so they need an explicit
 * revision instead of the generic settings row's second-granularity timestamp.
 * The singleton shape also leaves room for future semantic theme controls
 * without scattering presentation authority across generic keys. The legacy
 * `colors` column name now stores the complete sanitized JSON document.
 */
export const themeSettings = sqliteTable("theme_settings", {
    id: text("id").primaryKey().default("default"),
    colors: text("colors").notNull().default("{}"),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    check("theme_settings_singleton", sql`${table.id} = 'default'`),
    check("theme_settings_revision_positive", sql`${table.revision} >= 1`),
]);

/**
 * One shared, durable storefront-theme draft.
 *
 * Draft revision and published revision are separate concurrency authorities.
 * `basePublishedRevision` records the published document the draft was based on
 * so publish can fail closed instead of silently replacing newer storefront
 * presentation work.
 */
export const themeSettingsDrafts = sqliteTable("theme_settings_drafts", {
    id: text("id").primaryKey().default("default"),
    theme: text("theme").notNull(),
    revision: integer("revision").notNull().default(1),
    basePublishedRevision: integer("base_published_revision").notNull(),
    updatedBy: text("updated_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    check("theme_settings_drafts_singleton", sql`${table.id} = 'default'`),
    check("theme_settings_drafts_revision_positive", sql`${table.revision} >= 1`),
    check(
        "theme_settings_drafts_base_revision_nonnegative",
        sql`${table.basePublishedRevision} >= 0`,
    ),
]);

/** Immutable audit snapshots of every published semantic theme revision. */
export const themeSettingsVersions = sqliteTable("theme_settings_versions", {
    id: text("id").primaryKey(),
    publishedRevision: integer("published_revision").notNull().unique(),
    theme: text("theme").notNull(),
    source: text("source", { enum: ["publish", "rollback", "migration"] })
        .notNull(),
    sourceRevision: integer("source_revision"),
    publishedBy: text("published_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    check(
        "theme_settings_versions_revision_positive",
        sql`${table.publishedRevision} >= 1`,
    ),
    check(
        "theme_settings_versions_source_revision_positive",
        sql`${table.sourceRevision} IS NULL OR ${table.sourceRevision} >= 1`,
    ),
]);

/**
 * Short-lived preview snapshots. Only a SHA-256 token hash is persisted; the
 * bearer token stays in a storefront HttpOnly cookie and request bodies.
 */
export const themePreviewSessions = sqliteTable("theme_preview_sessions", {
    tokenHash: text("token_hash").primaryKey(),
    theme: text("theme").notNull(),
    draftRevision: integer("draft_revision").notNull(),
    basePublishedRevision: integer("base_published_revision").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("theme_preview_sessions_expires_at_idx").on(table.expiresAt),
    check(
        "theme_preview_sessions_draft_revision_positive",
        sql`${table.draftRevision} >= 1`,
    ),
    check(
        "theme_preview_sessions_base_revision_nonnegative",
        sql`${table.basePublishedRevision} >= 0`,
    ),
]);

export const analytics = sqliteTable("analytics", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    usePartytown: integer("use_partytown", { mode: "boolean" }).notNull().default(true),
    config: text("config").notNull(),
    location: text("location").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("analytics_type_idx").on(table.type),
    index("analytics_deleted_updated_idx").on(table.deletedAt, table.updatedAt),
    check("analytics_revision_positive", sql.raw(`"revision" >= 1`)),
]);

export const adminFcmTokens = sqliteTable("admin_fcm_tokens", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    deviceInfo: text("device_info"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    lastUsed: integer("last_used", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("admin_fcm_tokens_user_id_idx").on(table.userId),
]);

export const checkoutLanguages = sqliteTable("checkout_languages", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    code: text("code").notNull().unique(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    languageData: text("language_data").notNull(),
    fieldVisibility: text("field_visibility").notNull(),
    /** Optimistic-concurrency revision of the merchant's checkout text and form fields. */
    revision: integer("revision").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("checkout_languages_deleted_at_idx").on(table.deletedAt),
    uniqueIndex("checkout_languages_one_active_idx")
        .on(table.isActive)
        .where(sql`${table.isActive} = true`),
    uniqueIndex("checkout_languages_one_default_idx")
        .on(table.isDefault)
        .where(sql`${table.isDefault} = true`),
]);

export type Setting = InferSelectModel<typeof settings>;
export type Analytics = InferSelectModel<typeof analytics>;
export type AdminFcmToken = InferSelectModel<typeof adminFcmTokens>;
export type CheckoutLanguage = InferSelectModel<typeof checkoutLanguages>;
