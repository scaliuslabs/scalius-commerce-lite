// Plugin platform runtime state (packages/plugin-sdk/docs/apps.md, P1).
//
// `plugin_installations` is the authority for what may run: one row per
// plugin with its validated manifest, the grant a Super Admin approved, its
// status and its settings (secret fields sealed under a key HKDF-derived from
// CREDENTIAL_ENCRYPTION_KEY). `plugin_registrations` is derived from the manifest in
// the same batch as every manifest write, so "who implements function point X"
// or "who listens to topic Y" is one index read that returns nothing when no
// plugin declares it.
//
// `plugin_kv` and `plugin_log_entries` are owned by the plugin id, not the
// installation row: uninstalling with retained data keeps them for reinstall.
// Typed app records live in object_records (./objects).

import { sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { customers } from "./customers";
import { eventOutbox } from "./events";
import { UNIX_NOW } from "./shared";

export const PLUGIN_INSTALLATION_SOURCES = ["bundled", "registry", "upload"] as const;
export type PluginInstallationSource = (typeof PLUGIN_INSTALLATION_SOURCES)[number];
export const PLUGIN_INSTALLATION_STATUSES = ["installed", "active", "disabled", "failed"] as const;
export type PluginInstallationStatus = (typeof PLUGIN_INSTALLATION_STATUSES)[number];
export const PLUGIN_REGISTRATION_KINDS = ["event", "function", "cron", "provider"] as const;
export type PluginRegistrationKind = (typeof PLUGIN_REGISTRATION_KINDS)[number];
export const PLUGIN_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type PluginLogLevel = (typeof PLUGIN_LOG_LEVELS)[number];

const pluginIdShape = (column: ReturnType<typeof text>) =>
    sql`length(${column}) BETWEEN 3 AND 100 AND ${column} NOT GLOB '*[^a-z0-9.-]*' AND instr(${column}, '.') > 1 AND instr(${column}, '.') < length(${column})`;
const jsonObject = (column: ReturnType<typeof text>, maxLength: number) =>
    sql`json_valid(${column}) AND json_type(${column}) = 'object' AND length(${column}) <= ${sql.raw(String(maxLength))}`;


export const pluginInstallations = sqliteTable("plugin_installations", {
    pluginId: text("plugin_id").primaryKey(),
    version: text("version").notNull(),
    source: text("source", { enum: PLUGIN_INSTALLATION_SOURCES }).notNull(),
    /** SHA-256 (hex) of the plugin bundle; the sandbox isolate key and the bundled-code check. */
    bundleSha256: text("bundle_sha256").notNull(),
    /** The validated manifest (`@scalius/shared/plugins`), defaults filled. */
    manifestJson: text("manifest_json").notNull(),
    /** The approved `PluginGrantRequest`; null until a Super Admin approves. */
    grantJson: text("grant_json"),
    grantKey: text("grant_key"),
    status: text("status", { enum: PLUGIN_INSTALLATION_STATUSES }).notNull().default("installed"),
    failureReason: text("failure_reason"),
    /** Setting values by key; `secret` fields hold `ps1:` ciphertext, never plaintext. */
    settingsJson: text("settings_json").notNull().default("{}"),
    /** Compare-and-set revision for every installation write. */
    revision: integer("revision").notNull().default(1),
    installedBy: text("installed_by").references(() => user.id, { onDelete: "set null" }),
    /** The Super Admin who approved the active grant; plugin API writes are recorded as theirs. */
    activatedBy: text("activated_by").references(() => user.id, { onDelete: "set null" }),
    installedAt: integer("installed_at").notNull().default(UNIX_NOW),
    activatedAt: integer("activated_at"),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
    /** The newest data update (`manifest.migrations`) that ran; the host runs newer ones before the app's next run. */
    migratedVersion: integer("migrated_version").notNull().default(0),
    /** The trusted key id that verified the bundle (registry or signed upload); null for bundled code and unsigned uploads. */
    signerKeyId: text("signer_key_id"),
    /** Bytes the app keeps in object_records and plugin_kv, as last measured (the scheduled sweep). */
    storageBytes: integer("storage_bytes").notNull().default(0),
    storageMeasuredAt: integer("storage_measured_at"),
    /** Limit breaches in the current window (one counted a minute); enough of them stop the app. */
    breachCount: integer("breach_count").notNull().default(0),
    lastBreachAt: integer("last_breach_at"),
}, (table) => [
    index("plugin_installations_status_idx").on(table.status, table.pluginId),
    check("plugin_installations_id_shape", pluginIdShape(table.pluginId)),
    check("plugin_installations_version_length", sql`length(${table.version}) BETWEEN 5 AND 80`),
    check("plugin_installations_source_check", sql`${table.source} IN ('bundled', 'registry', 'upload')`),
    check("plugin_installations_sha256_shape", sql`length(${table.bundleSha256}) = 64 AND ${table.bundleSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("plugin_installations_manifest_json", jsonObject(table.manifestJson, 262144)),
    check("plugin_installations_grant_json", sql`${table.grantJson} IS NULL OR (${jsonObject(table.grantJson, 65536)})`),
    check("plugin_installations_grant_pair", sql`(${table.grantJson} IS NULL) = (${table.grantKey} IS NULL)`),
    check("plugin_installations_status_check", sql`${table.status} IN ('installed', 'active', 'disabled', 'failed')`),
    check("plugin_installations_active_granted", sql`${table.status} <> 'active' OR ${table.grantJson} IS NOT NULL`),
    check("plugin_installations_failure_reason", sql`${table.failureReason} IS NULL OR length(${table.failureReason}) BETWEEN 1 AND 500`),
    check("plugin_installations_settings_json", jsonObject(table.settingsJson, 131072)),
    check("plugin_installations_revision_positive", sql`${table.revision} >= 1`),
    // The 0125 columns are added in place (no table rebuild, so the cache
    // dependency triggers stay); their writers keep them in range.
]);

/**
 * The data updates (`manifest.migrations`) that ran for an app, one row per
 * version. Owned by the plugin id like its records: an uninstall that keeps
 * data keeps them, so a reinstall does not run them again.
 */
export const pluginMigrations = sqliteTable("plugin_migrations", {
    pluginId: text("plugin_id").notNull(),
    version: integer("version").notNull(),
    /** The app version that ran it. */
    pluginVersion: text("plugin_version").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    appliedAt: integer("applied_at").notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.pluginId, table.version] }),
    check("plugin_migrations_plugin_id_shape", pluginIdShape(table.pluginId)),
    check("plugin_migrations_version_range", sql`${table.version} BETWEEN 1 AND 10000`),
    check("plugin_migrations_plugin_version_length", sql`length(${table.pluginVersion}) BETWEEN 5 AND 80`),
    check("plugin_migrations_duration", sql`${table.durationMs} >= 0`),
]);

/** Extension-point registrations derived from an installation's manifest. */
export const pluginRegistrations = sqliteTable("plugin_registrations", {
    kind: text("kind", { enum: PLUGIN_REGISTRATION_KINDS }).notNull(),
    /** A topic filter (`order.paid`, `order.*`, `*`), a function point, a cron job name or a provider port (`payment`). */
    name: text("name").notNull(),
    pluginId: text("plugin_id")
        .notNull()
        .references(() => pluginInstallations.pluginId, { onDelete: "cascade" }),
    /** Lower runs first among plugins at the same function point. */
    priority: integer("priority").notNull().default(100),
    /**
     * A function's circuit (migration 0179, `@scalius/shared/plugins/function-circuit`):
     * failed answers (a throw, timeout, invalid answer or failed read) in the
     * window that began at `circuit_window_at`; at the threshold the circuit
     * opens until `circuit_open_until` and checkout applies the function's
     * failure policy without calling the app. A good answer closes it. A
     * re-registration (update, reactivation) starts closed.
     */
    circuitFailures: integer("circuit_failures").notNull().default(0),
    circuitWindowAt: integer("circuit_window_at"),
    circuitOpenUntil: integer("circuit_open_until"),
    /**
     * Set just before a sandboxed function runs and cleared when it answers
     * (or fails): one still set long after the wall limit means the run never
     * returned (it held its thread), and the next checkout stops the app
     * instead of running it again.
     */
    circuitInflightAt: integer("circuit_inflight_at"),
}, (table) => [
    primaryKey({ columns: [table.kind, table.name, table.pluginId] }),
    index("plugin_registrations_plugin_idx").on(table.pluginId),
    check("plugin_registrations_kind_check", sql`${table.kind} IN ('event', 'function', 'cron', 'provider')`),
    check("plugin_registrations_name_length", sql`length(${table.name}) BETWEEN 1 AND 64`),
    check("plugin_registrations_priority_range", sql`${table.priority} BETWEEN 0 AND 1000`),
]);

/** A plugin's small key/value store (database-backed, not Workers KV). */
export const pluginKv = sqliteTable("plugin_kv", {
    pluginId: text("plugin_id").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    /** Advances by one with every write of the key: the compare-and-set token. */
    revision: integer("revision").notNull().default(1),
    /** Epoch seconds after which the entry reads as absent; null never expires. */
    expiresAt: integer("expires_at"),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.pluginId, table.key] }),
    index("plugin_kv_expires_idx").on(table.pluginId, table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
    check("plugin_kv_plugin_id_shape", pluginIdShape(table.pluginId)),
    check("plugin_kv_key_length", sql`length(${table.key}) BETWEEN 1 AND 256`),
    check("plugin_kv_value_json", sql`json_valid(${table.valueJson}) AND length(${table.valueJson}) <= 65536`),
    check("plugin_kv_revision_positive", sql`${table.revision} >= 1`),
    check("plugin_kv_expires_positive", sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > 0`),
]);

/** A bounded ring of each plugin's newest log lines (masked before they are written). */
export const pluginLogEntries = sqliteTable("plugin_log_entries", {
    /** `plg_` + epoch milliseconds (13 digits) + 12 random hex: unique and time-sortable. */
    id: text("id").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    level: text("level", { enum: PLUGIN_LOG_LEVELS }).notNull(),
    /** What ran: `event:order.paid`, `function:checkout.discounts`, `route:admin/dashboard`, `cron:tidy`, `lifecycle:activate`, `host`. */
    source: text("source").notNull(),
    message: text("message").notNull(),
    fieldsJson: text("fields_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("plugin_log_entries_plugin_idx").on(table.pluginId, table.id),
    check("plugin_log_entries_id_shape", sql`length(${table.id}) = 29 AND substr(${table.id}, 1, 4) = 'plg_'`),
    check("plugin_log_entries_plugin_id_shape", pluginIdShape(table.pluginId)),
    check("plugin_log_entries_level_check", sql`${table.level} IN ('debug', 'info', 'warn', 'error')`),
    check("plugin_log_entries_source_length", sql`length(${table.source}) BETWEEN 1 AND 80`),
    check("plugin_log_entries_message_length", sql`length(${table.message}) BETWEEN 1 AND 500`),
    check("plugin_log_entries_fields_json", jsonObject(table.fieldsJson, 4096)),
]);

// ── Phase 2 (0107): event deliveries and cron runs ────────────────────────

export const PLUGIN_EVENT_DELIVERY_STATUSES = [
    "pending",
    "processing",
    "succeeded",
    "failed",
    "exhausted",
    "cancelled",
] as const;
export type PluginEventDeliveryStatus = (typeof PLUGIN_EVENT_DELIVERY_STATUSES)[number];

/**
 * One row per (plugin, event): the delivery's durable state and its bounded
 * attempt log, the plugin twin of `webhook_event_deliveries`. Keyed by plugin
 * id (not the installation row) so an uninstall that keeps data keeps the log.
 */
export const pluginEventDeliveries = sqliteTable("plugin_event_deliveries", {
    /** `pld_` + epoch milliseconds (13 digits) + 12 random hex: unique and time-sortable. */
    id: text("id").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    /** Set null when the event is pruned; topic and resource stay. */
    eventId: text("event_id").references(() => eventOutbox.id, { onDelete: "set null" }),
    topic: text("topic").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    status: text("status", { enum: PLUGIN_EVENT_DELIVERY_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(UNIX_NOW),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    /** Unused since 0148 (queue retirement); the Turso engine cannot drop the column. */
    queuedAt: integer("queued_at"),
    lastAttemptAt: integer("last_attempt_at"),
    durationMs: integer("duration_ms"),
    /** The last attempt's failure, masked like the plugin log. */
    lastError: text("last_error"),
    deliveredAt: integer("delivered_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("plugin_event_deliveries_plugin_event_unique")
        .on(table.pluginId, table.eventId)
        .where(sql`${table.eventId} IS NOT NULL`),
    index("plugin_event_deliveries_due_idx").on(table.status, table.nextAttemptAt),
    index("plugin_event_deliveries_claim_idx").on(table.status, table.claimExpiresAt),
    index("plugin_event_deliveries_plugin_idx").on(table.pluginId, table.id),
    index("plugin_event_deliveries_plugin_status_idx").on(table.pluginId, table.status, table.claimExpiresAt),
    index("plugin_event_deliveries_event_idx").on(table.eventId).where(sql`${table.eventId} IS NOT NULL`),
    index("plugin_event_deliveries_created_idx").on(table.createdAt),
    check("plugin_event_deliveries_id_shape", sql`length(${table.id}) = 29 AND substr(${table.id}, 1, 4) = 'pld_'`),
    check("plugin_event_deliveries_plugin_id_shape", pluginIdShape(table.pluginId)),
    check("plugin_event_deliveries_status_check", sql`${table.status} IN ('pending', 'enqueueing', 'queued', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled')`),
    check("plugin_event_deliveries_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check("plugin_event_deliveries_error_length", sql`${table.lastError} IS NULL OR length(${table.lastError}) <= 500`),
]);

export const PLUGIN_CRON_RUN_STATUSES = ["running", "succeeded", "failed"] as const;
export type PluginCronRunStatus = (typeof PLUGIN_CRON_RUN_STATUSES)[number];

/**
 * Cron claims: a run is the row for (plugin, job, slot), inserted once, so two
 * ticks can never both run a slot; the partial unique index allows one
 * `running` row per job, so runs of one job never overlap. A lease bounds a
 * run whose Worker died; the next tick marks it failed.
 */
export const pluginCronRuns = sqliteTable("plugin_cron_runs", {
    pluginId: text("plugin_id").notNull(),
    cronName: text("cron_name").notNull(),
    /** The schedule slot this run is for (epoch seconds). */
    scheduledFor: integer("scheduled_for").notNull(),
    status: text("status", { enum: PLUGIN_CRON_RUN_STATUSES }).notNull().default("running"),
    claimId: text("claim_id").notNull(),
    startedAt: integer("started_at").notNull().default(UNIX_NOW),
    leaseExpiresAt: integer("lease_expires_at").notNull(),
    finishedAt: integer("finished_at"),
    durationMs: integer("duration_ms"),
    error: text("error"),
}, (table) => [
    primaryKey({ columns: [table.pluginId, table.cronName, table.scheduledFor] }),
    uniqueIndex("plugin_cron_runs_one_running").on(table.pluginId, table.cronName).where(sql`${table.status} = 'running'`),
    index("plugin_cron_runs_lease_idx").on(table.status, table.leaseExpiresAt),
    index("plugin_cron_runs_started_idx").on(table.startedAt),
    check("plugin_cron_runs_plugin_id_shape", pluginIdShape(table.pluginId)),
    check("plugin_cron_runs_name_length", sql`length(${table.cronName}) BETWEEN 1 AND 48`),
    check("plugin_cron_runs_status_check", sql`${table.status} IN ('running', 'succeeded', 'failed')`),
    check("plugin_cron_runs_finished_shape", sql`(${table.status} = 'running') = (${table.finishedAt} IS NULL)`),
    check("plugin_cron_runs_error_length", sql`${table.error} IS NULL OR length(${table.error}) <= 500`),
]);

export type PluginInstallationRow = InferSelectModel<typeof pluginInstallations>;
export type PluginKvRow = InferSelectModel<typeof pluginKv>;
export type PluginLogRow = InferSelectModel<typeof pluginLogEntries>;
export type PluginEventDeliveryRow = InferSelectModel<typeof pluginEventDeliveries>;
export type PluginCronRunRow = InferSelectModel<typeof pluginCronRuns>;

/** What an app may create and later permanently delete itself (`app_resource_owners`). */
export const APP_OWNED_RESOURCE_TYPES = ["product", "category", "brand", "collection", "media"] as const;
export type AppOwnedResourceType = (typeof APP_OWNED_RESOURCE_TYPES)[number];

/**
 * The app that created a catalogue resource (migration 0165): written by the
 * platform when an app's create operation succeeds (`ctx.api.call`), never by
 * the app. It is the one authority for
 * `dashboard.resources.app_content.delete`: an app permanently deletes only
 * what it created, and only from the trash. A missing row (a staff-made
 * resource, or a create whose record write failed) means "not the app's".
 * Uninstalling an app deletes its rows. Private operational state: no public
 * read touches it.
 */
export const appResourceOwners = sqliteTable("app_resource_owners", {
    resourceType: text("resource_type", { enum: APP_OWNED_RESOURCE_TYPES }).notNull(),
    resourceId: text("resource_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.resourceType, table.resourceId] }),
    index("app_resource_owners_plugin_idx").on(table.pluginId),
    check("app_resource_owners_type_check", sql`${table.resourceType} IN ('product', 'category', 'brand', 'collection', 'media')`),
    check("app_resource_owners_plugin_shape", pluginIdShape(table.pluginId)),
]);
export type AppResourceOwner = InferSelectModel<typeof appResourceOwners>;

/**
 * App-defined customer roles (migration 0171): an app grants a role it names
 * (`seller`, `wholesale`) to a customer, with an optional reference to its own
 * record (`ref`, the app's seller id). Each app reads and writes only its own
 * rows; app pages see them as `request.customer.roles` and checkout functions
 * as `cart.customer.roles`. A customer's hard delete removes them; uninstalling
 * the app without keeping its data deletes the app's rows. Private state: no
 * public read touches it. The checks mirror `@scalius/shared/plugins/customer-roles`.
 */
export const pluginCustomerRoles = sqliteTable("plugin_customer_roles", {
    pluginId: text("plugin_id").notNull(),
    customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    ref: text("ref"),
    grantedAt: integer("granted_at").notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.pluginId, table.customerId, table.role] }),
    index("plugin_customer_roles_customer_idx").on(table.customerId),
    index("plugin_customer_roles_role_idx").on(table.pluginId, table.role, table.customerId),
    check("plugin_customer_roles_plugin_shape", pluginIdShape(table.pluginId)),
    check("plugin_customer_roles_role_shape", sql`length(${table.role}) BETWEEN 1 AND 32 AND substr(${table.role}, 1, 1) BETWEEN 'a' AND 'z' AND ${table.role} NOT GLOB '*[^a-z0-9_-]*'`),
    check("plugin_customer_roles_ref_shape", sql`${table.ref} IS NULL OR (length(${table.ref}) BETWEEN 1 AND 128 AND ${table.ref} NOT GLOB '*[^ -~]*')`),
]);
export type PluginCustomerRoleRow = InferSelectModel<typeof pluginCustomerRoles>;
