// Admin custom field routes (COMMERCE-HOOKS H4).
//
// Definitions (`/admin/custom-field-definitions`) are store settings: list,
// create, revision-guarded edit, delete and reorder. Values
// (`/admin/custom-fields/<owner type>/{ownerId}`) are read and written per
// owner, one route pair per owner type so each maps to its owner's RBAC
// family (products.*, customers.*, orders.*, …). Every write here is the
// merchant's: it may touch only the `custom` namespace. Storefront-visible
// writes are buyer-visible; database triggers advance their dependencies.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { isoTimestampSchema, nullableIsoTimestampSchema } from "../../schemas/timestamps";
import {
  createCustomFieldDefinition,
  deleteCustomFieldDefinition,
  getCustomFieldDefinition,
  listCustomFieldDefinitions,
  readCustomFieldValues,
  reorderCustomFieldDefinitions,
  setCustomFieldValues,
  updateCustomFieldDefinition,
} from "@scalius/core/modules/custom-fields";
import {
  createCustomFieldDefinitionSchema,
  customFieldDefinitionIdSchema,
  customFieldOwnerIdSchema,
  customFieldOwnerTypeSchema,
  customFieldTypeSchema,
  reorderCustomFieldDefinitionsSchema,
  setCustomFieldValuesSchema,
  updateCustomFieldDefinitionSchema,
} from "@scalius/core/modules/custom-fields/browser";
import {
  CUSTOM_FIELD_OWNER_TYPES,
  MERCHANT_CUSTOM_FIELD_WRITER,
  type CustomFieldOwnerType,
} from "@scalius/shared/custom-fields";
import { ok, created } from "../../utils/api-response";
import { NotFoundError } from "../../utils/api-error";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";

const merchant = { writer: MERCHANT_CUSTOM_FIELD_WRITER };
const DEFINITION_TAGS = ["Admin - Custom data"];

const wireBoundSchema = z.union([z.string(), z.number()]).nullable();
const validationsSchema = z.object({
  to: z.string().nullable().optional(),
  min: wireBoundSchema.optional(),
  max: wireBoundSchema.optional(),
  regex: z.string().nullable().optional(),
  choices: z.array(z.string()).nullable().optional(),
});

export const customFieldDefinitionSchema = z.object({
  id: z.string(),
  ownerType: customFieldOwnerTypeSchema,
  namespace: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: customFieldTypeSchema,
  validations: validationsSchema,
  storefrontVisible: z.boolean(),
  position: z.number().int(),
  revision: z.number().int().min(1),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).openapi("AdminCustomFieldDefinition");

const definitionListItemSchema = customFieldDefinitionSchema.extend({
  valueCount: z.number().int().min(0).describe("Owners holding a value; deleting the definition removes them."),
});

const ownerValuesSchema = z.object({
  ownerType: customFieldOwnerTypeSchema,
  ownerId: z.string(),
  fields: z.array(z.object({
    definition: customFieldDefinitionSchema,
    value: z.unknown().describe("JSON per the field type (lists as arrays, money as { amountMinor, currency }: integer minor units of the store currency); null when unset."),
    updatedAt: nullableIsoTimestampSchema,
  })),
});

type OwnerValuesWire = z.output<typeof ownerValuesSchema>;

const idParams = z.object({ id: customFieldDefinitionIdSchema });
const definitionErrors = { ...errorResponses, 409: conflictResponse };

// ─────────────────────────────────────────
// Definitions
// ─────────────────────────────────────────

export const customFieldDefinitionRoutes = new OpenAPIHono<{ Bindings: Env }>();

const listRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "dashboard.custom_field_definitions.list",
  tags: DEFINITION_TAGS,
  summary: "List custom field definitions",
  description: "Definitions in their display order, optionally for one owner type, each with how many owners hold a value.",
  request: { query: z.object({ ownerType: customFieldOwnerTypeSchema.optional() }) },
  responses: {
    200: {
      description: "Definitions",
      content: { "application/json": { schema: successEnvelope(z.object({ definitions: z.array(definitionListItemSchema) })) } },
    },
    ...errorResponses,
  },
});

customFieldDefinitionRoutes.openapi(listRoute, async (c) => {
  return ok(c, await listCustomFieldDefinitions(c.get("db"), { ownerType: c.req.valid("query").ownerType }));
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "dashboard.custom_field_definitions.get",
  tags: DEFINITION_TAGS,
  summary: "Get a custom field definition",
  request: { params: idParams },
  responses: {
    200: {
      description: "Definition",
      content: { "application/json": { schema: successEnvelope(z.object({ definition: customFieldDefinitionSchema })) } },
    },
    ...errorResponses,
  },
});

customFieldDefinitionRoutes.openapi(getRoute, async (c) => {
  const definition = await getCustomFieldDefinition(c.get("db"), c.req.valid("param").id);
  if (!definition) throw new NotFoundError("Custom field not found");
  return ok(c, { definition });
});

const createDefinitionRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "dashboard.custom_field_definitions.create",
  tags: DEFINITION_TAGS,
  summary: "Create a custom field definition",
  description: "Adds a field at the end of its owner type's order. Owner type, namespace, key and type are fixed once created.",
  request: { body: { content: { "application/json": { schema: createCustomFieldDefinitionSchema } } } },
  responses: {
    201: {
      description: "Definition created",
      content: { "application/json": { schema: successEnvelope(z.object({ definition: customFieldDefinitionSchema })) } },
    },
    ...definitionErrors,
  },
});

customFieldDefinitionRoutes.openapi(createDefinitionRoute, async (c) => {
  return created(c, { definition: await createCustomFieldDefinition(c.get("db"), c.req.valid("json"), merchant) });
});

const reorderRoute = createRoute({
  method: "post",
  path: "/reorder",
  operationId: "dashboard.custom_field_definitions.reorder",
  tags: DEFINITION_TAGS,
  summary: "Reorder the custom fields of an owner type",
  description: "Takes every definition of the owner type, each at its current revision, in the new order (all or none).",
  request: { body: { content: { "application/json": { schema: reorderCustomFieldDefinitionsSchema } } } },
  responses: {
    200: {
      description: "Definitions in their new order",
      content: { "application/json": { schema: successEnvelope(z.object({ definitions: z.array(definitionListItemSchema) })) } },
    },
    ...definitionErrors,
  },
});

customFieldDefinitionRoutes.openapi(reorderRoute, async (c) => {
  return ok(c, await reorderCustomFieldDefinitions(c.get("db"), c.req.valid("json")));
});

const updateRoute = createRoute({
  method: "patch",
  path: "/{id}",
  operationId: "dashboard.custom_field_definitions.update",
  tags: DEFINITION_TAGS,
  summary: "Edit a custom field definition",
  description: "Changes the name, description, validations or storefront visibility under the definition's revision. Existing values are not re-validated.",
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: updateCustomFieldDefinitionSchema } } },
  },
  responses: {
    200: {
      description: "Definition saved",
      content: { "application/json": { schema: successEnvelope(z.object({ definition: customFieldDefinitionSchema })) } },
    },
    ...definitionErrors,
  },
});

customFieldDefinitionRoutes.openapi(updateRoute, async (c) => {
  return ok(c, { definition: await updateCustomFieldDefinition(c.get("db"), c.req.valid("param").id, c.req.valid("json"), merchant) });
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "dashboard.custom_field_definitions.delete",
  tags: DEFINITION_TAGS,
  summary: "Delete a custom field definition and every value of it",
  request: {
    params: idParams,
    query: z.object({ expectedRevision: z.coerce.number().int().min(1) }),
  },
  responses: {
    200: {
      description: "Definition deleted",
      content: { "application/json": { schema: successEnvelope(z.object({ id: z.string(), deletedValueCount: z.number().int().min(0) })) } },
    },
    ...definitionErrors,
  },
});

customFieldDefinitionRoutes.openapi(deleteRoute, async (c) => {
  return ok(c, await deleteCustomFieldDefinition(
    c.get("db"),
    c.req.valid("param").id,
    { expectedRevision: c.req.valid("query").expectedRevision },
    merchant,
  ));
});

// ─────────────────────────────────────────
// Values, per owner type
// ─────────────────────────────────────────

export const customFieldValueRoutes = new OpenAPIHono<{ Bindings: Env }>();

const OWNER_LABEL: Record<CustomFieldOwnerType, string> = {
  product: "product",
  variant: "product variant (SKU)",
  customer: "customer",
  order: "order",
  category: "category",
  collection: "collection",
  brand: "brand",
  page: "page",
};

function registerOwnerValueRoutes(ownerType: CustomFieldOwnerType): void {
  const label = OWNER_LABEL[ownerType];
  const params = z.object({ ownerId: customFieldOwnerIdSchema });
  const responses = {
    200: {
      description: `Every ${label} custom field with this ${label}'s value`,
      content: { "application/json": { schema: successEnvelope(ownerValuesSchema) } },
    },
  };

  const getValuesRoute = createRoute({
    method: "get",
    // One path per owner type; widened so the 8 registrations share one handler type.
    path: `/${ownerType}/{ownerId}` as string,
    operationId: `dashboard.custom_fields.get_${ownerType}_values`,
    tags: DEFINITION_TAGS,
    summary: `Get a ${label}'s custom fields`,
    request: { params },
    responses: { ...responses, ...errorResponses },
  });
  customFieldValueRoutes.openapi(getValuesRoute, async (c) => {
    // `value` is opaque JSON on both sides; the schema's type is the contract.
    const values: OwnerValuesWire = await readCustomFieldValues(c.get("db"), ownerType, c.req.valid("param").ownerId);
    return ok(c, values);
  });

  const setValuesRoute = createRoute({
    method: "put",
    path: `/${ownerType}/{ownerId}` as string,
    operationId: `dashboard.custom_fields.set_${ownerType}_values`,
    tags: DEFINITION_TAGS,
    summary: `Set or clear a ${label}'s custom fields`,
    description: "Validates every value and writes them in one batch (all or none). Null, an empty string or an empty list clears a value. Only `custom` namespace fields are writable here.",
    request: {
      params,
      body: { content: { "application/json": { schema: setCustomFieldValuesSchema } } },
    },
    responses: { ...responses, ...errorResponses, 409: conflictResponse },
  });
  customFieldValueRoutes.openapi(setValuesRoute, async (c) => {
    const values: OwnerValuesWire = await setCustomFieldValues(c.get("db"), ownerType, c.req.valid("param").ownerId, c.req.valid("json"), merchant);
    return ok(c, values);
  });
}

for (const ownerType of CUSTOM_FIELD_OWNER_TYPES) registerOwnerValueRoutes(ownerType);
