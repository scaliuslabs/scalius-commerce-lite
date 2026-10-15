// Static object operations: agents discover the fields at runtime; apps own
// their definitions in manifests and staff edit only types in custom.*.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  createObjectType, deleteObjectType, getObjectType, listObjectTypes, updateObjectType,
  deleteObjectEntry, getObjectEntry, listObjectRecords, upsertObjectRecord,
} from "@scalius/core/modules/objects";
import { objectFieldSchema, OBJECT_STATUSES, type ObjectField } from "@scalius/shared/plugins/objects";
import { ForbiddenError, NotFoundError, ValidationError } from "../../utils/api-error";
import { created, noContent, ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, namedSharedSchema, noContentResponse, successEnvelope } from "../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();
const TAG = "Admin - Objects";
const writeResponses = { ...errorResponses, 409: conflictResponse };
const statusSchema = z.enum(OBJECT_STATUSES);
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const indexSchema = z.union([z.string(), z.array(z.string()).min(1).max(4)]);
const fieldSchema = namedSharedSchema(objectFieldSchema, "ObjectField");
const typeBody = z.object({
  type: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  fields: z.array(fieldSchema).min(1).max(40),
  display: z.string().optional(),
  indexes: z.array(indexSchema).max(4).optional(),
  unique: z.array(indexSchema).max(2).optional(),
  handle: z.boolean().optional(),
  storefront: z.boolean().optional(),
  admin: z.enum(["none", "read", "edit"]).optional(),
  events: z.boolean().optional(),
}).strict();
const typeSchema = z.object({
  id: z.string(), handle: z.string(), namespace: z.string(), type: z.string(), name: z.string(),
  description: z.string().nullable(), fields: z.array(fieldSchema),
  indexes: z.array(indexSchema), unique: z.array(indexSchema), display: z.string().nullable(),
  storefront: z.boolean(), admin: z.enum(["none", "read", "edit"]), events: z.boolean(), handleEnabled: z.boolean(),
  owner: z.enum(["merchant", "app"]), recordCount: z.number().int(), revision: z.number().int(),
  createdAt: z.string(), updatedAt: z.string(),
}).openapi("ObjectType");
const recordSchema = z.object({
  id: z.string(), typeId: z.string(), handle: z.string().nullable(), status: statusSchema,
  displayName: z.string(), data: z.record(z.string(), z.unknown()),
  position: z.number().int(), revision: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
}).openapi("ObjectRecord");
const typeParam = z.object({ type: z.string().min(1).max(160) });
const recordParams = typeParam.extend({ id: z.string().min(1).max(128) });
const revisionQuery = z.object({ expectedRevision: z.coerce.number().int().min(1) });

app.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});

async function accessibleType(c: Context, handle: string, edit = false) {
  const type = await getObjectType(c.get("db"), handle);
  if (!type || type.admin === "none") throw new NotFoundError("Object type not found");
  const principal = c.get("pluginPrincipal") as { pluginId: string } | undefined;
  if (principal && type.namespace !== "custom" && type.namespace !== principal.pluginId) throw new ForbiddenError("An app may access only its own or custom object types");
  if (edit && type.admin !== "edit") throw new ForbiddenError("This object type is read-only");
  return type;
}

async function customType(c: Context, handle: string) {
  const type = await accessibleType(c, handle);
  if (type.namespace !== "custom") throw new ForbiddenError("App object types are owned by the app manifest");
  return type;
}

/** Schema uses wire values (money/decimal majors), matching the field codec. */
export function objectFieldsJsonSchema(fields: Pick<ObjectField, "key" | "name" | "type" | "to" | "required" | "validations">[]) {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const field of fields) {
    const list = field.type.startsWith("list.");
    const item = list ? field.type.slice(5) : field.type;
    const value: Record<string, unknown> = item === "json" ? {} : {
      type: item === "boolean" ? "boolean" : item === "integer" ? "integer" : item === "money" || item === "decimal" ? ["number", "string"] : "string",
    };
    if (item === "date") value.format = "date";
    if (item === "date_time") value.format = "date-time";
    if (item === "url") value.format = "uri";
    if (field.validations?.choices) value.enum = field.validations.choices;
    if (field.validations?.regex) value.pattern = field.validations.regex;
    if (field.validations?.min != null) value[item === "integer" || item === "decimal" || item === "money" ? "minimum" : "minLength"] = Number(field.validations.min);
    if (field.validations?.max != null) value[item === "integer" || item === "decimal" || item === "money" ? "maximum" : "maxLength"] = Number(field.validations.max);
    properties[field.key] = { ...(list ? { type: "array", items: value } : value), title: field.name, ...(field.to ? { "x-object-type": field.to } : {}) };
  }
  return { type: "object", properties, required: fields.filter((field) => field.required).map((field) => field.key), additionalProperties: false };
}

export function objectWhereQuery(url: string): Record<string, z.infer<typeof scalar>> | undefined {
  const query = new URL(url).searchParams;
  let where: Record<string, z.infer<typeof scalar>> = {};
  if (query.has("where")) {
    try { where = z.record(z.string(), scalar).parse(JSON.parse(query.get("where")!)); }
    catch { throw new ValidationError("where must be a JSON object of scalar values"); }
  }
  for (const [key, value] of query) {
    const match = /^where\[([a-z][a-z0-9_]{0,63})\]$/.exec(key);
    if (!match) {
      if (key.startsWith("where[")) throw new ValidationError("Invalid where field name");
      continue;
    }
    if (Object.hasOwn(where, match[1]!)) throw new ValidationError("A where field may appear only once");
    Object.defineProperty(where, match[1]!, { value, enumerable: true, writable: true, configurable: true });
  }
  if (Object.keys(where).length > 4) throw new ValidationError("Filter on at most four indexed fields");
  return Object.keys(where).length ? where : undefined;
}

app.openapi(createRoute({
  operationId: "objects.types.list", method: "get", path: "/types", tags: [TAG], summary: "List object types available to staff",
  responses: { 200: { description: "Object types", content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(typeSchema) })) } } }, ...errorResponses },
}), async (c) => {
  const principal = c.get("pluginPrincipal") as { pluginId: string } | undefined;
  const items = (await listObjectTypes(c.get("db"))).filter((type) => type.admin !== "none" && (!principal || type.namespace === "custom" || type.namespace === principal.pluginId));
  return ok(c, { items });
});

app.openapi(createRoute({
  operationId: "objects.types.create", method: "post", path: "/types", tags: [TAG], summary: "Create a merchant object type",
  description: "Creates only in custom.*. App object types are manifest-owned.",
  request: { body: { content: { "application/json": { schema: typeBody } } } },
  responses: { 201: { description: "Created type", content: { "application/json": { schema: successEnvelope(z.object({ type: typeSchema })) } } }, ...writeResponses },
}), async (c) => created(c, { type: await createObjectType(c.get("db"), c.req.valid("json")) }));

app.openapi(createRoute({
  operationId: "objects.types.get", method: "get", path: "/types/{type}", tags: [TAG], summary: "Get an object type and its record JSON Schema",
  request: { params: typeParam },
  responses: { 200: { description: "Object type", content: { "application/json": { schema: successEnvelope(z.object({ type: typeSchema, jsonSchema: z.record(z.string(), z.unknown()) })) } } }, ...errorResponses },
}), async (c) => {
  const type = await accessibleType(c, c.req.valid("param").type);
  return ok(c, { type, jsonSchema: objectFieldsJsonSchema(type.fields) });
});

app.openapi(createRoute({
  operationId: "objects.types.update", method: "patch", path: "/types/{type}", tags: [TAG], summary: "Update a merchant object type at its current revision",
  request: { params: typeParam, body: { content: { "application/json": { schema: typeBody.omit({ type: true }).extend({ expectedRevision: z.number().int().min(1) }) } } } },
  responses: { 200: { description: "Updated type", content: { "application/json": { schema: successEnvelope(z.object({ type: typeSchema })) } } }, ...writeResponses },
}), async (c) => {
  const type = await customType(c, c.req.valid("param").type);
  return ok(c, { type: await updateObjectType(c.get("db"), type.id, c.req.valid("json")) });
});

app.openapi(createRoute({
  operationId: "objects.types.delete", method: "delete", path: "/types/{type}", tags: [TAG], summary: "Delete a merchant object type and its records",
  request: { params: typeParam, query: revisionQuery }, responses: { 204: noContentResponse, ...writeResponses },
}), async (c) => {
  const type = await customType(c, c.req.valid("param").type);
  await deleteObjectType(c.get("db"), type.id, c.req.valid("query").expectedRevision);
  return noContent(c);
});

app.openapi(createRoute({
  operationId: "objects.list", method: "get", path: "/{type}", tags: [TAG], summary: "List object records using indexed filters and a cursor",
  description: "where accepts a JSON scalar object or bracket parameters such as where[customer]=cus_123. Only index-leading fields may filter or sort.",
  request: { params: typeParam, query: z.object({
    where: z.string().max(4096).optional(), cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50), status: statusSchema.optional(),
    orderBy: z.string().max(64).optional(), direction: z.enum(["asc", "desc"]).optional(),
  }) },
  responses: { 200: { description: "Object records", content: { "application/json": { schema: successEnvelope(z.object({ type: typeSchema, records: z.array(recordSchema), nextCursor: z.string().nullable(), total: z.number().int() })) } } }, ...errorResponses },
}), async (c) => {
  const type = await accessibleType(c, c.req.valid("param").type);
  const { where: _where, orderBy, direction, ...query } = c.req.valid("query");
  const where = objectWhereQuery(c.req.url);
  // Bracket query strings are converted only where the declared field is typed.
  for (const [key, value] of Object.entries(where ?? {})) {
    const field = type.fields.find((field) => field.key === key);
    if (typeof value !== "string") continue;
    if (field?.type === "integer" && /^-?\d+$/.test(value)) where![key] = Number(value);
    if (field?.type === "boolean" && (value === "true" || value === "false")) where![key] = value === "true";
  }
  return ok(c, await listObjectRecords(c.get("db"), type.id, { ...query, where, ...(orderBy ? { orderBy: { field: orderBy, direction } } : {}) }));
});

app.openapi(createRoute({
  operationId: "objects.get", method: "get", path: "/{type}/{id}", tags: [TAG], summary: "Get an object record",
  request: { params: recordParams },
  responses: { 200: { description: "Object record", content: { "application/json": { schema: successEnvelope(z.object({ record: recordSchema })) } } }, ...errorResponses },
}), async (c) => {
  const { type: handle, id } = c.req.valid("param");
  const type = await accessibleType(c, handle);
  const record = await getObjectEntry(c.get("db"), type.id, id);
  if (!record) throw new NotFoundError("Object record not found");
  return ok(c, { record });
});

app.openapi(createRoute({
  operationId: "objects.upsert", method: "put", path: "/{type}/{id}", tags: [TAG], summary: "Create or replace an object record at its current revision",
  description: "expectedRevision=null requires a new id; an integer requires the matching existing revision. Data is validated against the object type.",
  request: { params: recordParams, body: { content: { "application/json": { schema: z.object({
    data: z.record(z.string(), z.unknown()), expectedRevision: z.number().int().min(1).nullable(),
    handle: z.string().max(100).optional(), status: statusSchema.optional(), position: z.number().int().min(0).max(1_000_000).optional(),
  }).strict() } } } },
  responses: { 200: { description: "Saved record", content: { "application/json": { schema: successEnvelope(z.object({ record: recordSchema })) } } }, ...writeResponses },
}), async (c) => {
  const { type: handle, id } = c.req.valid("param");
  const type = await accessibleType(c, handle, true);
  return ok(c, { record: await upsertObjectRecord(c.get("db"), type.id, id, c.req.valid("json")) });
});

app.openapi(createRoute({
  operationId: "objects.delete", method: "delete", path: "/{type}/{id}", tags: [TAG], summary: "Delete an object record at its current revision",
  request: { params: recordParams, query: revisionQuery }, responses: { 204: noContentResponse, ...writeResponses },
}), async (c) => {
  const { type: handle, id } = c.req.valid("param");
  const type = await accessibleType(c, handle, true);
  await deleteObjectEntry(c.get("db"), type.id, id, c.req.valid("query").expectedRevision);
  return noContent(c);
});

export { app as adminObjectRoutes };
