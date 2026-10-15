// Custom fields (COMMERCE-HOOKS H4): typed values attached to products,
// SKUs, customers, orders, categories, collections, brands and pages.
//
// A definition is unique per (owner_type, namespace, key); `custom` is the
// merchant's namespace and a plugin writes under its plugin id. A value is
// one canonical text per (definition, owner), validated by the shared codec
// (`@scalius/shared/custom-fields`), whose vocabularies the CHECKs mirror.
// The composite foreign key keeps a value's owner type equal to its
// definition's, and deleting a definition deletes its values. Deleting an
// owner row deletes its values through the cleanup triggers of migration
// 0104 (an owner in trash keeps them). Storefront-visible values and
// definitions advance the owner's cache keys (cache-deps registry).

import { sqliteTable, text, integer, index, uniqueIndex, check, primaryKey, foreignKey } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";

/** Mirrors `CUSTOM_FIELD_OWNER_TYPES` in `@scalius/shared/custom-fields`. */
export const CUSTOM_FIELD_OWNER_TYPE_VALUES = [
    "product",
    "variant",
    "customer",
    "order",
    "category",
    "collection",
    "brand",
    "page",
] as const;

/** Mirrors `CUSTOM_FIELD_TYPES` in `@scalius/shared/custom-fields`. */
export const CUSTOM_FIELD_TYPE_VALUES = [
    "single_line_text",
    "multi_line_text",
    "integer",
    "decimal",
    "boolean",
    "date",
    "date_time",
    "url",
    "color",
    "json",
    "money",
    "product_reference",
    "variant_reference",
    "collection_reference",
    "media_reference",
    "object_reference",
    "list.single_line_text",
    "list.multi_line_text",
    "list.integer",
    "list.decimal",
    "list.date",
    "list.date_time",
    "list.url",
    "list.color",
    "list.money",
    "list.product_reference",
    "list.variant_reference",
    "list.collection_reference",
    "list.media_reference",
    "list.object_reference",
] as const;

const inList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const OWNER_TYPES_SQL = inList(CUSTOM_FIELD_OWNER_TYPE_VALUES);

export const customFieldDefinitions = sqliteTable("custom_field_definitions", {
    id: text("id").primaryKey(),
    ownerType: text("owner_type", { enum: CUSTOM_FIELD_OWNER_TYPE_VALUES }).notNull(),
    /** `custom` (the merchant) or the writing plugin's id (`vendor.name`). */
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type", { enum: CUSTOM_FIELD_TYPE_VALUES }).notNull(),
    /** Stored validations JSON (`{min,max,regex,choices}`), canonical per the shared codec. */
    validations: text("validations").notNull().default("{}"),
    storefrontVisible: integer("storefront_visible", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull().default(0),
    /** Optimistic concurrency token of every definition write. */
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    check("custom_field_definitions_id_shape", sql`substr(${table.id}, 1, 4) = 'cfd_' AND length(${table.id}) BETWEEN 10 AND 68 AND ${table.id} NOT GLOB '*[^A-Za-z0-9_-]*'`),
    check("custom_field_definitions_owner_type_check", sql.raw(`"owner_type" IN (${OWNER_TYPES_SQL})`)),
    // `custom`, or a plugin id `vendor.name` (PLUGIN_ID_PATTERN): lowercase
    // slugs, exactly one inner dot, no dash at either end or next to the dot.
    // Each GLOB pattern here has a PostgreSQL regex twin (compileGlobPatterns).
    check("custom_field_definitions_namespace_shape", sql`${table.namespace} = 'custom' OR (length(${table.namespace}) BETWEEN 3 AND 101 AND ${table.namespace} NOT GLOB '*[^a-z0-9.-]*' AND instr(${table.namespace}, '.') > 1 AND instr(${table.namespace}, '.') < length(${table.namespace}) AND instr(substr(${table.namespace}, instr(${table.namespace}, '.') + 1), '.') = 0 AND substr(${table.namespace}, 1, 1) <> '-' AND substr(${table.namespace}, length(${table.namespace}), 1) <> '-' AND instr(${table.namespace}, '-.') = 0 AND instr(${table.namespace}, '.-') = 0)`),
    check("custom_field_definitions_key_shape", sql`length(${table.key}) BETWEEN 2 AND 64 AND ${table.key} NOT GLOB '*[^_a-z0-9]*' AND substr(${table.key}, 1, 1) GLOB '[a-z]'`),
    check("custom_field_definitions_name_valid", sql`${table.name} = trim(${table.name}) AND length(${table.name}) BETWEEN 1 AND 80`),
    check("custom_field_definitions_description_length", sql`${table.description} IS NULL OR length(${table.description}) <= 300`),
    check("custom_field_definitions_type_check", sql.raw(`"type" IN (${inList(CUSTOM_FIELD_TYPE_VALUES)})`)),
    check("custom_field_definitions_validations_json", sql`json_valid(${table.validations}) AND substr(${table.validations}, 1, 1) = '{'`),
    // Customer and order fields are never shown to buyers.
    check("custom_field_definitions_storefront_owner", sql`${table.storefrontVisible} = 0 OR (${table.storefrontVisible} = 1 AND ${table.ownerType} NOT IN ('customer', 'order'))`),
    check("custom_field_definitions_revision_positive", sql`${table.revision} >= 1`),
    uniqueIndex("custom_field_definitions_owner_key_unique").on(table.ownerType, table.namespace, table.key),
    // The target of the values' composite foreign key.
    uniqueIndex("custom_field_definitions_id_owner_unique").on(table.id, table.ownerType),
    index("custom_field_definitions_owner_position_idx").on(table.ownerType, table.position),
]);

export const customFieldValues = sqliteTable("custom_field_values", {
    definitionId: text("definition_id").notNull(),
    ownerType: text("owner_type", { enum: CUSTOM_FIELD_OWNER_TYPE_VALUES }).notNull(),
    /** The owning row's id (products, product_variants, customers, …). */
    ownerId: text("owner_id").notNull(),
    /** Canonical text per the shared codec (money in integer minor units). */
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.definitionId, table.ownerId] }),
    foreignKey({
        name: "custom_field_values_definition_fk",
        columns: [table.definitionId, table.ownerType],
        foreignColumns: [customFieldDefinitions.id, customFieldDefinitions.ownerType],
    }).onDelete("cascade"),
    index("custom_field_values_owner_idx").on(table.ownerType, table.ownerId),
    check("custom_field_values_owner_type_check", sql.raw(`"owner_type" IN (${OWNER_TYPES_SQL})`)),
    check("custom_field_values_owner_id_length", sql`length(${table.ownerId}) BETWEEN 1 AND 128`),
    check("custom_field_values_value_length", sql`length(${table.value}) BETWEEN 1 AND 65536`),
]);

export type CustomFieldDefinitionRow = InferSelectModel<typeof customFieldDefinitions>;
export type CustomFieldValueRow = InferSelectModel<typeof customFieldValues>;
