// Plugin platform runtime state (docs/platform/PLUGINS.md, P1).
//
// `plugin_installations` is the authority for what may run: one row per
// plugin with its validated manifest, the grant a Super Admin approved, its
// status and its settings (secret fields sealed under a key HKDF-derived from
// CREDENTIAL_ENCRYPTION_KEY). `plugin_registrations` is derived from the manifest in
// the same batch as every manifest write, so "who implements function point X"
// or "who listens to topic Y" is one index read that returns nothing when no
// plugin declares it.
//
// `plugin_records` (declared storage collections), `plugin_kv` and
// `plugin_log_entries` are owned by the plugin id, not by the installation row: an
// uninstall that keeps data leaves them for a reinstall. Indexed values are
// stored as lowercase hex of an order-preserving tuple encoding, so equality,
// prefix ranges and ordering behave identically under every provider's text
// collation (D1, TursoDB, PostgreSQL).

import { sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { UNIX_NOW } from "./shared";

export const PLUGIN_INSTALLATION_SOURCES = ["bundled", "registry", "upload"] as const;
export type PluginInstallationSource = (typeof PLUGIN_INSTALLATION_SOURCES)[number];
export const PLUGIN_INSTALLATION_STATUSES = ["installed", "active", "disabled", "failed"] as const;
export type PluginInstallationStatus = (typeof PLUGIN_INSTALLATION_STATUSES)[number];
export const PLUGIN_REGISTRATION_KINDS = ["event", "function", "cron"] as const;
export type PluginRegistrationKind = (typeof PLUGIN_REGISTRATION_KINDS)[number];
export const PLUGIN_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type PluginLogLevel = (typeof PLUGIN_LOG_LEVELS)[number];

const pluginIdShape = (column: ReturnType<typeof text>) =>
    sql`length(${column}) BETWEEN 3 AND 100 AND ${column} NOT GLOB '*[^a-z0-9.-]*' AND instr(${column}, '.') > 1 AND instr(${column}, '.') < length(${column})`;
const jsonObject = (column: ReturnType<typeof text>, maxLength: number) =>
    sql`json_valid(${column}) AND json_type(${column}) = 'object' AND length(${column}) <= ${sql.raw(String(maxLength))}`;
const hexIndex = (column: ReturnType<typeof text>) =>
    sql`${column} IS NULL OR (length(${column}) BETWEEN 2 AND 2048 AND ${column} NOT GLOB '*[^0-9a-f]*')`;

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
]);

/** Extension-point registrations derived from an installation's manifest. */
export const pluginRegistrations = sqliteTable("plugin_registrations", {
    kind: text("kind", { enum: PLUGIN_REGISTRATION_KINDS }).notNull(),
    /** A topic filter (`order.paid`, `order.*`, `*`), a function point or a cron job name. */
    name: text("name").notNull(),
    pluginId: text("plugin_id")
        .notNull()
        .references(() => pluginInstallations.pluginId, { onDelete: "cascade" }),
    /** Lower runs first among plugins at the same function point. */
    priority: integer("priority").notNull().default(100),
}, (table) => [
    primaryKey({ columns: [table.kind, table.name, table.pluginId] }),
    index("plugin_registrations_plugin_idx").on(table.pluginId),
    check("plugin_registrations_kind_check", sql`${table.kind} IN ('event', 'function', 'cron')`),
    check("plugin_registrations_name_length", sql`length(${table.name}) BETWEEN 1 AND 64`),
    check("plugin_registrations_priority_range", sql`${table.priority} BETWEEN 0 AND 1000`),
]);

/** One record of a plugin's declared storage collection. */
export const pluginRecords = sqliteTable("plugin_records", {
    pluginId: text("plugin_id").notNull(),
    collection: text("collection").notNull(),
    id: text("id").notNull(),
    dataJson: text("data_json").notNull(),
    /** Encoded values of the collection's declared indexes, in declaration order. */
    idx1: text("idx1"),
    idx2: text("idx2"),
    idx3: text("idx3"),
    idx4: text("idx4"),
    /** Encoded values of the collection's declared unique indexes (null exempts a record). */
    uq1: text("uq1"),
    uq2: text("uq2"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.pluginId, table.collection, table.id] }),
    index("plugin_records_idx1").on(table.pluginId, table.collection, table.idx1, table.id),
    index("plugin_records_idx2").on(table.pluginId, table.collection, table.idx2, table.id),
    index("plugin_records_idx3").on(table.pluginId, table.collection, table.idx3, table.id),
    index("plugin_records_idx4").on(table.pluginId, table.collection, table.idx4, table.id),
    uniqueIndex("plugin_records_uq1").on(table.pluginId, table.collection, table.uq1).where(sql`${table.uq1} IS NOT NULL`),
    uniqueIndex("plugin_records_uq2").on(table.pluginId, table.collection, table.uq2).where(sql`${table.uq2} IS NOT NULL`),
    check("plugin_records_plugin_id_shape", pluginIdShape(table.pluginId)),
    check("plugin_records_collection_shape", sql`length(${table.collection}) BETWEEN 1 AND 48 AND ${table.collection} NOT GLOB '*[^a-z0-9-]*'`),
    check("plugin_records_id_length", sql`length(${table.id}) BETWEEN 1 AND 128`),
    check("plugin_records_data_json", jsonObject(table.dataJson, 65536)),
    check("plugin_records_idx1_hex", hexIndex(table.idx1)),
    check("plugin_records_idx2_hex", hexIndex(table.idx2)),
    check("plugin_records_idx3_hex", hexIndex(table.idx3)),
    check("plugin_records_idx4_hex", hexIndex(table.idx4)),
    check("plugin_records_uq1_hex", hexIndex(table.uq1)),
    check("plugin_records_uq2_hex", hexIndex(table.uq2)),
]);

/** A plugin's small key/value store (database-backed, not Workers KV). */
export const pluginKv = sqliteTable("plugin_kv", {
    pluginId: text("plugin_id").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    /** Epoch seconds after which the entry reads as absent; null never expires. */
    expiresAt: integer("expires_at"),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.pluginId, table.key] }),
    index("plugin_kv_expires_idx").on(table.pluginId, table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
    check("plugin_kv_plugin_id_shape", pluginIdShape(table.pluginId)),
    check("plugin_kv_key_length", sql`length(${table.key}) BETWEEN 1 AND 256`),
    check("plugin_kv_value_json", sql`json_valid(${table.valueJson}) AND length(${table.valueJson}) <= 65536`),
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

export type PluginInstallationRow = InferSelectModel<typeof pluginInstallations>;
export type PluginRecordRow = InferSelectModel<typeof pluginRecords>;
export type PluginKvRow = InferSelectModel<typeof pluginKv>;
export type PluginLogRow = InferSelectModel<typeof pluginLogEntries>;
