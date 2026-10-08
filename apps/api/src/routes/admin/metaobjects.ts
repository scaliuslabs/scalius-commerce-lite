// Metaobjects (docs/platform/PLUGINS.md, "Metaobjects"; Shopify
// metaobjects), mounted at /admin/metaobjects: content types (definitions)
// and their entries for the dashboard, agents and apps (`ctx.api`). The
// merchant defines types in `custom`; an app's types come from its manifest
// and only it changes them (a call as the app writes its own namespace).
// Entries are content anyone with `metaobjects.edit` writes. Every write is
// guarded by the revision the caller read.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  createMetaobjectDefinition,
  createMetaobjectEntry,
  deleteMetaobjectDefinition,
  deleteMetaobjectEntry,
  getMetaobjectDefinition,
  getMetaobjectEntry,
  listMetaobjectDefinitions,
  listMetaobjectEntries,
  MERCHANT_METAOBJECT_WRITER,
  updateMetaobjectDefinition,
  updateMetaobjectEntry,
  type MetaobjectWriter,
} from "@scalius/core/modules/metaobjects";
import { CUSTOM_FIELD_TYPES, type CustomFieldType } from "@scalius/shared/custom-fields";
import { METAOBJECT_ENTRY_STATUSES } from "@scalius/shared/metaobjects";
import { NotFoundError } from "../../utils/api-error";
import { created, noContent, ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, noContentResponse, successEnvelope } from "../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();
const TAG = "Admin - Metaobjects";
const writeResponses = { ...errorResponses, 409: conflictResponse };

function noStore(c: Context) {
  c.header("Cache-Control", "private, no-store");
}

/** The merchant, or the app calling as itself (its own namespace). */
function writerOf(c: Context): MetaobjectWriter {
  const plugin = (c as unknown as { get(key: "pluginPrincipal"): { pluginId: string } | undefined }).get("pluginPrincipal");
  return plugin ? { kind: "plugin", pluginId: plugin.pluginId } : MERCHANT_METAOBJECT_WRITER;
}

const fieldDefinitionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  name: z.string().trim().min(1).max(80),
  type: z.enum(CUSTOM_FIELD_TYPES as unknown as [CustomFieldType, ...CustomFieldType[]]).openapi({ description: "A custom-field type." }),
  required: z.boolean().default(false),
  description: z.string().trim().max(300).optional(),
}).openapi("MetaobjectFieldDefinition");

const definitionSchema = z.object({
  id: z.string(),
  handle: z.string().openapi({ description: "<namespace>.<type>: custom.faq, or an app's acme.loyalty.tiers." }),
  namespace: z.string(),
  type: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  fields: z.array(fieldDefinitionSchema),
  displayField: z.string().nullable(),
  storefrontAccess: z.boolean().openapi({ description: "Published entries are readable by the storefront (theme sections)." }),
  owner: z.enum(["merchant", "app"]),
  entryCount: z.number().int(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi("MetaobjectDefinition");

const entrySchema = z.object({
  id: z.string(),
  definitionId: z.string(),
  handle: z.string(),
  displayName: z.string(),
  status: z.enum(METAOBJECT_ENTRY_STATUSES),
  fields: z.record(z.string(), z.unknown()).openapi({ description: "Field key → value in the custom-field contract (money in major units)." }),
  position: z.number().int(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi("MetaobjectEntry");

const definitionBody = z.object({
  type: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).openapi({ description: "The type handle, fixed once created." }),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  fields: z.array(fieldDefinitionSchema).min(1).max(30),
  displayField: z.string().optional(),
  storefrontAccess: z.boolean().default(false),
});
const definitionPatch = definitionBody.omit({ type: true }).extend({ expectedRevision: z.number().int().min(1) });
const entryBody = z.object({
  handle: z.string().max(100).optional().openapi({ description: "Lowercase letters, digits and dashes; made from the display field when left out." }),
  status: z.enum(METAOBJECT_ENTRY_STATUSES).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  position: z.number().int().min(0).max(1_000_000).optional(),
});
const idParam = z.object({ id: z.string().min(1).max(68) });
const entryParams = z.object({ id: z.string().min(1).max(68), entryId: z.string().min(1).max(68) });

app.openapi(createRoute({
  operationId: "dashboard.metaobjects.definitions_list",
  method: "get",
  path: "/definitions",
  tags: [TAG],
  summary: "Content types, by name",
  description: "Every metaobject definition (the merchant's and the active apps'), with its fields and how many entries it holds.",
  responses: {
    200: { description: "Content types", content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(definitionSchema) })) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, { items: await listMetaobjectDefinitions(c.get("db")) });
});

app.openapi(createRoute({
  operationId: "dashboard.metaobjects.definitions_create",
  method: "post",
  path: "/definitions",
  tags: [TAG],
  summary: "Create a content type",
  description: "A merchant type in `custom` (an app calling as itself creates one in its own namespace). Field types are the custom-field types.",
  request: { body: { content: { "application/json": { schema: definitionBody } } } },
  responses: {
    201: { description: "The content type", content: { "application/json": { schema: successEnvelope(z.object({ definition: definitionSchema })) } } },
    ...writeResponses,
  },
}), async (c) => {
  return created(c, { definition: await createMetaobjectDefinition(c.get("db"), c.req.valid("json"), writerOf(c)) });
});

app.openapi(createRoute({
  operationId: "dashboard.metaobjects.definitions_get",
  method: "get",
  path: "/definitions/{id}",
  tags: [TAG],
  summary: "Get a content type",
  request: { params: idParam },
  responses: {
    200: { description: "The content type", content: { "application/json": { schema: successEnvelope(z.object({ definition: definitionSchema })) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const definition = await getMetaobjectDefinition(c.get("db"), c.req.valid("param").id);
  if (!definition) throw new NotFoundError("Content type not found");
  return ok(c, { definition });
});

app.openapi(createRoute({
  operationId: "dashboard.metaobjects.definitions_update",
  method: "patch",
  path: "/definitions/{id}",
  tags: [TAG],
  summary: "Change a content type",
  description: "Name, fields, display field and storefront access, at the revision read. A field's type cannot change while entries hold a value for it. An app's type changes only through its app.",
  request: { params: idParam, body: { content: { "application/json": { schema: definitionPatch } } } },
  responses: {
    200: { description: "The content type", content: { "application/json": { schema: successEnvelope(z.object({ definition: definitionSchema })) } } },
    ...writeResponses,
  },
}), async (c) => {
  const definition = await updateMetaobjectDefinition(c.get("db"), c.req.valid("param").id, c.req.valid("json"), writerOf(c));
  return ok(c, { definition });
});

app.openapi(createRoute({
  operationId: "dashboard.metaobjects.definitions_delete",
  method: "delete",
  path: "/definitions/{id}",
  tags: [TAG],
  summary: "Delete a content type and its entries",
  request: { params: idParam, query: z.object({ expectedRevision: z.coerce.number().int().min(1) }) },
  responses: { 204: noContentResponse, ...writeResponses },
}), async (c) => {
  await deleteMetaobjectDefinition(c.get("db"), c.req.valid("param").id, c.req.valid("query").expectedRevision, writerOf(c));
  return noContent(c);
});

app.openapi(createRoute({
  operationId: "dashboard.metaobjects.entries_list",
  method: "get",
  path: "/definitions/{id}/entries",
  tags: [TAG],
  summary: "A content type's entries, in order",
  request: {
    params: idParam,
    query: z.object({
      status: z.enum(METAOBJECT_ENTRY_STATUSES).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(1_000).default(0),
    }),
  },
  responses: {
    200: {
      description: "Entries",
      content: { "application/json": { schema: successEnvelope(z.object({ definition: definitionSchema, entries: z.array(entrySchema), total: z.number().int() })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, await listMetaobjectEntries(c.get("db"), c.req.valid("param").id, c.req.valid("query")));
});

app.openapi(createRoute({
  operationId: "dashboard.metaobjects.entries_create",
  method: "post",
  path: "/definitions/{id}/entries",
  tags: [TAG],
  summary: "Create an entry",
  description: "Values follow the field types (the custom-field contract). A published entry needs every required field.",
  request: { params: idParam, body: { content: { "application/json": { schema: entryBody } } } },
  responses: {
    201: { description: "The entry", content: { "application/json": { schema: successEnvelope(z.object({ entry: entrySchema })) } } },
    ...writeResponses,
  },
}), async (c) => {
  return created(c, { entry: await createMetaobjectEntry(c.get("db"), c.req.valid("param").id, c.req.valid("json")) });
});

app.openapi(createRoute({
  operationId: "dashboard.metaobjects.entries_get",
  method: "get",
  path: "/definitions/{id}/entries/{entryId}",
  tags: [TAG],
  summary: "Get an entry",
  request: { params: entryParams },
  responses: {
    200: { description: "The entry", content: { "application/json": { schema: successEnvelope(z.object({ entry: entrySchema })) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const { id, entryId } = c.req.valid("param");
  const entry = await getMetaobjectEntry(c.get("db"), id, entryId);
  if (!entry) throw new NotFoundError("Entry not found");
  return ok(c, { entry });
});

app.openapi(createRoute({
  operationId: "dashboard.metaobjects.entries_update",
  method: "patch",
  path: "/definitions/{id}/entries/{entryId}",
  tags: [TAG],
  summary: "Change an entry",
  description: "Only the fields sent change (null clears one); status, handle and position too. At the revision read.",
  request: { params: entryParams, body: { content: { "application/json": { schema: entryBody.extend({ expectedRevision: z.number().int().min(1) }) } } } },
  responses: {
    200: { description: "The entry", content: { "application/json": { schema: successEnvelope(z.object({ entry: entrySchema })) } } },
    ...writeResponses,
  },
}), async (c) => {
  const { id, entryId } = c.req.valid("param");
  return ok(c, { entry: await updateMetaobjectEntry(c.get("db"), id, entryId, c.req.valid("json")) });
});

app.openapi(createRoute({
  operationId: "dashboard.metaobjects.entries_delete",
  method: "delete",
  path: "/definitions/{id}/entries/{entryId}",
  tags: [TAG],
  summary: "Delete an entry",
  request: { params: entryParams, query: z.object({ expectedRevision: z.coerce.number().int().min(1) }) },
  responses: { 204: noContentResponse, ...writeResponses },
}), async (c) => {
  const { id, entryId } = c.req.valid("param");
  await deleteMetaobjectEntry(c.get("db"), id, entryId, c.req.valid("query").expectedRevision);
  return noContent(c);
});

export { app as adminMetaobjectRoutes };
