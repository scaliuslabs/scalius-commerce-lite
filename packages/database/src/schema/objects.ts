import { sql, type InferSelectModel } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { UNIX_NOW } from "./shared";

export const objectTypes = sqliteTable("object_types", {
  id: text("id").primaryKey(),
  namespace: text("namespace").notNull(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  fieldsJson: text("fields_json").notNull(),
  indexesJson: text("indexes_json").notNull().default("[]"),
  uniqueJson: text("unique_json").notNull().default("[]"),
  displayField: text("display_field"),
  storefront: integer("storefront", { mode: "boolean" }).notNull().default(false),
  admin: text("admin", { enum: ["none", "read", "edit"] }).notNull().default("none"),
  events: integer("events", { mode: "boolean" }).notNull().default(false),
  handleEnabled: integer("handle", { mode: "boolean" }).notNull().default(false),
  revision: integer("revision").notNull().default(1),
  createdAt: integer("created_at").notNull().default(UNIX_NOW),
  updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
  uniqueIndex("object_types_namespace_type_unique").on(table.namespace, table.type),
  check("object_types_id_shape", sql`${table.id} = 'oty_' || ${table.namespace} || '.' || ${table.type}`),
  check("object_types_namespace_shape", sql`${table.namespace} = 'custom' OR (length(${table.namespace}) BETWEEN 3 AND 101 AND ${table.namespace} NOT GLOB '*[^a-z0-9.-]*' AND instr(${table.namespace}, '.') > 1 AND instr(${table.namespace}, '.') < length(${table.namespace}))`),
  check("object_types_type_shape", sql`length(${table.type}) BETWEEN 2 AND 48 AND ${table.type} NOT GLOB '*[^_a-z0-9]*' AND substr(${table.type}, 1, 1) GLOB '[a-z]'`),
  check("object_types_name_valid", sql`${table.name} = trim(${table.name}) AND length(${table.name}) BETWEEN 1 AND 80`),
  check("object_types_description_length", sql`${table.description} IS NULL OR length(${table.description}) <= 300`),
  check("object_types_fields_json", sql`json_valid(${table.fieldsJson}) AND json_type(${table.fieldsJson}) = 'array' AND length(${table.fieldsJson}) <= 65536`),
  check("object_types_indexes_json", sql`json_valid(${table.indexesJson}) AND json_type(${table.indexesJson}) = 'array' AND length(${table.indexesJson}) <= 2048`),
  check("object_types_unique_json", sql`json_valid(${table.uniqueJson}) AND json_type(${table.uniqueJson}) = 'array' AND length(${table.uniqueJson}) <= 1024`),
  check("object_types_admin_check", sql`${table.admin} IN ('none', 'read', 'edit')`),
  check("object_types_flags", sql`${table.storefront} IN (0, 1) AND ${table.events} IN (0, 1) AND ${table.handleEnabled} IN (0, 1)`),
  check("object_types_revision_positive", sql`${table.revision} >= 1`),
]);

export const objectRecords = sqliteTable("object_records", {
  typeId: text("type_id").notNull().references(() => objectTypes.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  handle: text("handle"),
  status: text("status", { enum: ["active", "draft", "published"] }).notNull().default("active"),
  dataJson: text("data_json").notNull(),
  revision: integer("revision").notNull().default(1),
  k1: text("k1"), k2: text("k2"), k3: text("k3"), k4: text("k4"),
  u1: text("u1"), u2: text("u2"),
  pub: integer("pub", { mode: "boolean" }).notNull().default(false),
  ev: integer("ev", { mode: "boolean" }).notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: integer("created_at").notNull().default(UNIX_NOW),
  updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
  primaryKey({ columns: [table.typeId, table.id] }),
  ...(["k1", "k2", "k3", "k4"] as const).map((key) => index(`object_records_${key}`).on(table.typeId, table[key], table.id).where(sql`${table[key]} IS NOT NULL`)),
  ...(["u1", "u2"] as const).map((key) => uniqueIndex(`object_records_${key}`).on(table.typeId, table[key]).where(sql`${table[key]} IS NOT NULL`)),
  uniqueIndex("object_records_handle").on(table.typeId, table.handle).where(sql`${table.handle} IS NOT NULL`),
  index("object_records_public_position").on(table.typeId, table.position, table.id).where(sql`${table.pub} = 1`),
  check("object_records_id_length", sql`length(${table.id}) BETWEEN 1 AND 128`),
  check("object_records_handle_shape", sql`${table.handle} IS NULL OR (length(${table.handle}) BETWEEN 1 AND 100 AND ${table.handle} NOT GLOB '*[^a-z0-9-]*' AND substr(${table.handle}, 1, 1) <> '-' AND substr(${table.handle}, length(${table.handle}), 1) <> '-')`),
  check("object_records_status_check", sql`${table.status} IN ('active', 'draft', 'published')`),
  check("object_records_data_json", sql`json_valid(${table.dataJson}) AND json_type(${table.dataJson}) = 'object' AND length(${table.dataJson}) <= 65536`),
  check("object_records_revision_positive", sql`${table.revision} >= 1`),
  check("object_records_flags", sql`${table.pub} IN (0, 1) AND ${table.ev} IN (0, 1) AND (${table.pub} = 0 OR ${table.status} = 'published')`),
  check("object_records_position_range", sql`${table.position} BETWEEN 0 AND 1000000`),
  ...(["k1", "k2", "k3", "k4", "u1", "u2"] as const).map((key) => check(`object_records_${key}_hex`, sql`${table[key]} IS NULL OR (length(${table[key]}) BETWEEN 2 AND 2048 AND ${table[key]} NOT GLOB '*[^0-9a-f]*')`)),
]);

export type ObjectTypeRow = InferSelectModel<typeof objectTypes>;
export type ObjectRecordRow = InferSelectModel<typeof objectRecords>;
