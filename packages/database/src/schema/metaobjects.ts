// Metaobjects (docs/platform/PLUGINS.md, "Metaobjects"; Shopify metaobjects):
// content types the merchant or an app defines (a size chart, an FAQ, a
// designer, a store location) and their entries. A definition is unique per
// (namespace, type): `custom` is the merchant's namespace and an app defines
// under its plugin id. Its fields reuse the custom-field types; an entry
// keeps one canonical text per field, validated by the shared codec
// (`@scalius/shared/custom-fields`). Published entries of a definition with
// storefront access are public: the theme builder shows them in sections,
// cached under the `mo:<definition id>` dependency (cache-deps registry).

import { sqliteTable, text, integer, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";

export const METAOBJECT_ENTRY_STATUSES = ["draft", "published"] as const;
export type MetaobjectEntryStatus = (typeof METAOBJECT_ENTRY_STATUSES)[number];

export const metaobjectDefinitions = sqliteTable("metaobject_definitions", {
    id: text("id").primaryKey(),
    /** `custom` (the merchant) or the defining app's id (`vendor.name`). */
    namespace: text("namespace").notNull(),
    /** The type handle within the namespace (`faq`, `size_chart`). */
    type: text("type").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Field definitions JSON: `[{ key, name, type, required, description?, validations }]`. */
    fields: text("fields").notNull().default("[]"),
    /** The field whose value names an entry in lists (absent: the handle). */
    displayField: text("display_field"),
    /** Published entries are readable by the storefront (sections in the theme builder). */
    storefrontAccess: integer("storefront_access", { mode: "boolean" }).notNull().default(false),
    /** Optimistic concurrency token of every definition write. */
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    check("metaobject_definitions_id_shape", sql`substr(${table.id}, 1, 4) = 'mod_' AND length(${table.id}) BETWEEN 10 AND 68 AND ${table.id} NOT GLOB '*[^A-Za-z0-9_-]*'`),
    check("metaobject_definitions_namespace_shape", sql`${table.namespace} = 'custom' OR (length(${table.namespace}) BETWEEN 3 AND 101 AND ${table.namespace} NOT GLOB '*[^a-z0-9.-]*' AND instr(${table.namespace}, '.') > 1 AND instr(${table.namespace}, '.') < length(${table.namespace}))`),
    check("metaobject_definitions_type_shape", sql`length(${table.type}) BETWEEN 2 AND 64 AND ${table.type} NOT GLOB '*[^_a-z0-9]*' AND substr(${table.type}, 1, 1) GLOB '[a-z]'`),
    check("metaobject_definitions_name_valid", sql`${table.name} = trim(${table.name}) AND length(${table.name}) BETWEEN 1 AND 80`),
    check("metaobject_definitions_description_length", sql`${table.description} IS NULL OR length(${table.description}) <= 300`),
    check("metaobject_definitions_fields_json", sql`json_valid(${table.fields}) AND substr(${table.fields}, 1, 1) = '[' AND length(${table.fields}) <= 65536`),
    check("metaobject_definitions_display_field_shape", sql`${table.displayField} IS NULL OR (length(${table.displayField}) BETWEEN 2 AND 64 AND ${table.displayField} NOT GLOB '*[^_a-z0-9]*')`),
    check("metaobject_definitions_revision_positive", sql`${table.revision} >= 1`),
    uniqueIndex("metaobject_definitions_namespace_type_unique").on(table.namespace, table.type),
]);

export const metaobjectEntries = sqliteTable("metaobject_entries", {
    id: text("id").primaryKey(),
    definitionId: text("definition_id").notNull().references(() => metaobjectDefinitions.id, { onDelete: "cascade" }),
    /** The entry's handle, unique within its definition (`shipping-faq`). */
    handle: text("handle").notNull(),
    status: text("status", { enum: METAOBJECT_ENTRY_STATUSES }).notNull().default("draft"),
    /** Field values JSON: `{ <key>: <canonical text> }`, per the definition's field types. */
    fields: text("fields").notNull().default("{}"),
    /** Lower comes first in lists and sections. */
    position: integer("position").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    check("metaobject_entries_id_shape", sql`substr(${table.id}, 1, 4) = 'moe_' AND length(${table.id}) BETWEEN 10 AND 68 AND ${table.id} NOT GLOB '*[^A-Za-z0-9_-]*'`),
    check("metaobject_entries_handle_shape", sql`length(${table.handle}) BETWEEN 1 AND 100 AND ${table.handle} NOT GLOB '*[^a-z0-9-]*' AND substr(${table.handle}, 1, 1) <> '-' AND substr(${table.handle}, length(${table.handle}), 1) <> '-'`),
    check("metaobject_entries_status_check", sql`${table.status} IN ('draft', 'published')`),
    check("metaobject_entries_fields_json", sql`json_valid(${table.fields}) AND substr(${table.fields}, 1, 1) = '{' AND length(${table.fields}) <= 262144`),
    check("metaobject_entries_position_range", sql`${table.position} BETWEEN 0 AND 1000000`),
    check("metaobject_entries_revision_positive", sql`${table.revision} >= 1`),
    uniqueIndex("metaobject_entries_definition_handle_unique").on(table.definitionId, table.handle),
    index("metaobject_entries_definition_status_position_idx").on(table.definitionId, table.status, table.position),
]);

export type MetaobjectDefinitionRow = InferSelectModel<typeof metaobjectDefinitions>;
export type MetaobjectEntryRow = InferSelectModel<typeof metaobjectEntries>;
