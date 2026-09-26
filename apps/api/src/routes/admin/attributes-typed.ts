// Admin OpenAPI routes for typed attributes: spec groups, the id-based value
// vocabulary (attribute_values), value-type conversion and category
// attribute sets. Mounted by ./attributes.ts before its own routes, under
// /api/v1/admin/attributes. Product value rewrites carry the catalogue
// projection refresh in their own batches (catalogProjectionRefreshStatements).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    convertAttributeTypeSchema,
    createAttributeGroupSchema,
    createAttributeValueRowSchema,
    reorderAttributeGroupsSchema,
    reorderAttributeValueRowsSchema,
    replaceCategoryAttributeSetSchema,
    updateAttributeGroupSchema,
    updateAttributeValueRowSchema,
} from "@scalius/core/modules/attributes/browser";
import {
    convertAttributeValueType,
    createAttributeGroup,
    createAttributeValueRow,
    deleteAttributeValueRow,
    getCategoryAttributeSet,
    listAttributeGroups,
    listAttributeValueRows,
    reorderAttributeGroups,
    reorderAttributeValueRows,
    replaceCategoryAttributeSet,
    trashAttributeGroup,
    updateAttributeGroup,
    updateAttributeValueRow,
    type CatalogProjectionRefresh,
} from "@scalius/core/modules/attributes";
import { catalogProjectionRefreshStatements } from "@scalius/core/modules/products";
import type { Database } from "@scalius/database/client";

import { created, noContent, ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, noContentResponse, successEnvelope } from "../../schemas/responses";
import { timestampSchema } from "../../schemas/timestamps";

const app = new OpenAPIHono<{ Bindings: Env }>();
const TAG = "Admin - Attributes";

/** The catalogue projection refresh the attribute writes append to their batches. */
function projectionRefresh(db: Database): CatalogProjectionRefresh {
    return (productIds) => catalogProjectionRefreshStatements(db, productIds);
}

const idParam = z.string().trim().min(1).max(180);
const valueTypeSchema = z.enum(["text", "number", "boolean", "enum"]);
const facetDisplaySchema = z.enum(["checkbox", "range", "swatch", "search_list"]);

// ── Attribute groups ──

const groupSchema = z.object({
    id: z.string().max(80),
    name: z.string().max(80),
    sortOrder: z.number().int(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
});
const groupWithCountSchema = groupSchema.extend({ attributeCount: z.number().int().nonnegative() });
const groupListSchema = z.object({ groups: z.array(groupWithCountSchema).max(500) });

app.openapi(createRoute({
    method: "get",
    path: "/groups",
    operationId: "dashboard.attribute_groups.list",
    tags: [TAG],
    summary: "List attribute groups",
    description: "Live spec-table groups in display order, each with its live attribute count.",
    responses: {
        200: { description: "Attribute groups", content: { "application/json": { schema: successEnvelope(groupListSchema) } } },
        ...errorResponses,
    },
}), async (c) => ok(c, await listAttributeGroups(c.get("db"))));

app.openapi(createRoute({
    method: "post",
    path: "/groups",
    operationId: "dashboard.attribute_groups.create",
    tags: [TAG],
    summary: "Create an attribute group",
    request: { body: { required: true, content: { "application/json": { schema: createAttributeGroupSchema } } } },
    responses: {
        201: { description: "Group created", content: { "application/json": { schema: successEnvelope(z.object({ group: groupWithCountSchema })) } } },
        ...errorResponses,
        409: conflictResponse,
    },
}), async (c) => {
    const result = await createAttributeGroup(c.get("db"), c.req.valid("json"));

    return created(c, result);
});

app.openapi(createRoute({
    method: "put",
    path: "/groups/order",
    operationId: "dashboard.attribute_groups.reorder",
    tags: [TAG],
    summary: "Reorder attribute groups",
    request: { body: { required: true, content: { "application/json": { schema: reorderAttributeGroupsSchema } } } },
    responses: {
        200: { description: "Groups reordered", content: { "application/json": { schema: successEnvelope(groupListSchema) } } },
        ...errorResponses,
    },
}), async (c) => {
    const result = await reorderAttributeGroups(c.get("db"), c.req.valid("json").items);

    return ok(c, result);
});

app.openapi(createRoute({
    method: "patch",
    path: "/groups/{groupId}",
    operationId: "dashboard.attribute_groups.update",
    tags: [TAG],
    summary: "Rename or reorder an attribute group",
    request: {
        params: z.object({ groupId: idParam }),
        body: { required: true, content: { "application/json": { schema: updateAttributeGroupSchema } } },
    },
    responses: {
        200: { description: "Group updated", content: { "application/json": { schema: successEnvelope(z.object({ group: groupSchema })) } } },
        ...errorResponses,
        409: conflictResponse,
    },
}), async (c) => {
    const { groupId } = c.req.valid("param");
    const result = await updateAttributeGroup(c.get("db"), groupId, c.req.valid("json"));

    return ok(c, result);
});

app.openapi(createRoute({
    method: "delete",
    path: "/groups/{groupId}",
    operationId: "dashboard.attribute_groups.trash",
    tags: [TAG],
    summary: "Trash an attribute group",
    description: "Soft-deletes the group; its attributes become ungrouped in the same batch.",
    request: { params: z.object({ groupId: idParam }) },
    responses: { 204: noContentResponse, ...errorResponses },
}), async (c) => {
    const { groupId } = c.req.valid("param");
    await trashAttributeGroup(c.get("db"), groupId);

    return noContent(c);
});

// ── Category attribute sets ──

const setEntrySchema = z.object({
    attributeId: z.string().max(180),
    name: z.string().max(100),
    slug: z.string().max(100),
    valueType: valueTypeSchema,
    unit: z.string().max(16).nullable(),
    facetDisplay: facetDisplaySchema,
    filterable: z.boolean(),
    keySpec: z.boolean(),
    highlight: z.boolean(),
    groupId: z.string().max(80).nullable(),
    sortOrder: z.number().int(),
    orderKey: z.number().int(),
    inheritedFromCategoryId: z.string().max(180).nullable(),
});
const categorySetSchema = z.object({
    categoryId: z.string().max(180),
    attributes: z.array(setEntrySchema).max(360),
});

app.openapi(createRoute({
    method: "get",
    path: "/category-sets/{categoryId}",
    operationId: "dashboard.attribute_sets.get",
    tags: [TAG],
    summary: "Get a category's effective attribute set",
    description:
        "The union of the category's own set and every ancestor's, root-most first (order key "
        + "(3 - depth) * 100000 + sortOrder; ties by name). `inheritedFromCategoryId` names the ancestor "
        + "a row comes from, null for the category's own rows.",
    request: { params: z.object({ categoryId: idParam }) },
    responses: {
        200: { description: "Effective attribute set", content: { "application/json": { schema: successEnvelope(categorySetSchema) } } },
        ...errorResponses,
    },
}), async (c) => {
    const { categoryId } = c.req.valid("param");
    return ok(c, await getCategoryAttributeSet(c.get("db"), categoryId));
});

app.openapi(createRoute({
    method: "put",
    path: "/category-sets/{categoryId}",
    operationId: "dashboard.attribute_sets.replace",
    tags: [TAG],
    summary: "Replace a category's own attribute set",
    description: "At most 90 live attributes; inherited rows are edited on their ancestor. Returns the effective set.",
    request: {
        params: z.object({ categoryId: idParam }),
        body: { required: true, content: { "application/json": { schema: replaceCategoryAttributeSetSchema } } },
    },
    responses: {
        200: { description: "Attribute set replaced", content: { "application/json": { schema: successEnvelope(categorySetSchema) } } },
        ...errorResponses,
        409: conflictResponse,
    },
}), async (c) => {
    const { categoryId } = c.req.valid("param");
    const result = await replaceCategoryAttributeSet(c.get("db"), categoryId, c.req.valid("json").attributes);

    return ok(c, result);
});

// ── Value vocabulary (attribute_values) ──

const valueRowSchema = z.object({
    id: z.string().max(80),
    value: z.string().max(200),
    normalizedValue: z.string().max(200),
    sortOrder: z.number().int(),
    swatchHex: z.string().max(7).nullable(),
});
const listedValueRowSchema = valueRowSchema.extend({
    productCount: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
});

app.openapi(createRoute({
    method: "get",
    path: "/{id}/normalized-values",
    operationId: "dashboard.attribute_values.list_normalized",
    tags: [TAG],
    summary: "List an attribute's value vocabulary",
    description: "Enum values (the only values products may pick) or text presets, in order, with product counts.",
    request: {
        params: z.object({ id: idParam }),
        query: z.object({
            search: z.string().trim().max(120).optional(),
            page: z.coerce.number().int().min(1).default(1),
            limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
    },
    responses: {
        200: {
            description: "Attribute values",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        attributeId: z.string().max(180),
                        attributeName: z.string().max(100),
                        valueType: valueTypeSchema,
                        values: z.array(listedValueRowSchema).max(100),
                        total: z.number().int().nonnegative(),
                        page: z.number().int(),
                        limit: z.number().int(),
                        totalPages: z.number().int(),
                    })),
                },
            },
        },
        ...errorResponses,
    },
}), async (c) => {
    const { id } = c.req.valid("param");
    return ok(c, await listAttributeValueRows(c.get("db"), id, c.req.valid("query")));
});

app.openapi(createRoute({
    method: "post",
    path: "/{id}/normalized-values",
    operationId: "dashboard.attribute_values.create_normalized",
    tags: [TAG],
    summary: "Add a value to an attribute's vocabulary",
    request: {
        params: z.object({ id: idParam }),
        body: { required: true, content: { "application/json": { schema: createAttributeValueRowSchema } } },
    },
    responses: {
        201: { description: "Value created", content: { "application/json": { schema: successEnvelope(z.object({ value: valueRowSchema })) } } },
        ...errorResponses,
        409: conflictResponse,
    },
}), async (c) => {
    const { id } = c.req.valid("param");
    const result = await createAttributeValueRow(c.get("db"), id, c.req.valid("json"));

    return created(c, result);
});

app.openapi(createRoute({
    method: "put",
    path: "/{id}/normalized-values/order",
    operationId: "dashboard.attribute_values.reorder",
    tags: [TAG],
    summary: "Reorder attribute values",
    description: "Sets the sort order of up to 90 values; enum reorders refresh the facet order of their products.",
    request: {
        params: z.object({ id: idParam }),
        body: { required: true, content: { "application/json": { schema: reorderAttributeValueRowsSchema } } },
    },
    responses: {
        200: {
            description: "Values reordered",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        updated: z.number().int().nonnegative(),
                        productsRefreshed: z.number().int().nonnegative(),
                    })),
                },
            },
        },
        ...errorResponses,
    },
}), async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const result = await reorderAttributeValueRows(db, id, c.req.valid("json").items, projectionRefresh(db));

    return ok(c, result);
});

app.openapi(createRoute({
    method: "patch",
    path: "/{id}/normalized-values/{valueId}",
    operationId: "dashboard.attribute_values.update_by_id",
    tags: [TAG],
    summary: "Rename, recolour or reorder one attribute value",
    description:
        "Renaming an enum value rewrites the display text of the products that use it (in bounded batches "
        + "with their projection refresh); renaming to an existing value is a conflict.",
    request: {
        params: z.object({ id: idParam, valueId: idParam }),
        body: { required: true, content: { "application/json": { schema: updateAttributeValueRowSchema } } },
    },
    responses: {
        200: {
            description: "Value updated",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        value: valueRowSchema,
                        productsUpdated: z.number().int().nonnegative(),
                    })),
                },
            },
        },
        ...errorResponses,
        409: conflictResponse,
    },
}), async (c) => {
    const db = c.get("db");
    const { id, valueId } = c.req.valid("param");
    const result = await updateAttributeValueRow(db, id, valueId, c.req.valid("json"), projectionRefresh(db));

    return ok(c, result);
});

app.openapi(createRoute({
    method: "delete",
    path: "/{id}/normalized-values/{valueId}",
    operationId: "dashboard.attribute_values.delete_by_id",
    tags: [TAG],
    summary: "Delete one attribute value",
    description:
        "Refused while products use an enum value unless `mergeIntoValueId` names another live value of the "
        + "same attribute: its products are repointed to that value first.",
    request: {
        params: z.object({ id: idParam, valueId: idParam }),
        query: z.object({ mergeIntoValueId: idParam.optional() }),
    },
    responses: {
        200: {
            description: "Value deleted",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        deleted: z.literal(true),
                        productsMerged: z.number().int().nonnegative(),
                    })),
                },
            },
        },
        ...errorResponses,
        409: conflictResponse,
    },
}), async (c) => {
    const db = c.get("db");
    const { id, valueId } = c.req.valid("param");
    const { mergeIntoValueId } = c.req.valid("query");
    const result = await deleteAttributeValueRow(db, id, valueId, { mergeIntoValueId }, projectionRefresh(db));

    return ok(c, result);
});

// ── Value type conversion ──

app.openapi(createRoute({
    method: "post",
    path: "/{id}/convert-type",
    operationId: "dashboard.attributes.convert_type",
    tags: [TAG],
    summary: "Convert an attribute to another value type",
    description:
        "Validates every product value first and refuses the whole conversion (count and up to 10 samples) "
        + "when any does not convert; `dryRun` returns that preview without writing. Otherwise switches the "
        + "type, then rewrites product values 90 products per batch with their projection refresh. Repeating "
        + "a conversion continues with the values not yet converted.",
    request: {
        params: z.object({ id: idParam }),
        body: { required: true, content: { "application/json": { schema: convertAttributeTypeSchema } } },
    },
    responses: {
        200: {
            description: "Conversion preview or result",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        attributeId: z.string().max(180),
                        fromType: valueTypeSchema,
                        valueType: valueTypeSchema,
                        facetDisplay: facetDisplaySchema,
                        unit: z.string().max(16).nullable(),
                        dryRun: z.boolean(),
                        rows: z.number().int().nonnegative(),
                        distinctValues: z.number().int().nonnegative(),
                        newValues: z.number().int().nonnegative(),
                        unconvertibleCount: z.number().int().nonnegative(),
                        unconvertibleSamples: z.array(z.string().max(2000)).max(10),
                        converted: z.number().int().nonnegative(),
                        skipped: z.number().int().nonnegative(),
                        skippedSamples: z.array(z.string().max(2000)).max(10),
                        changed: z.boolean(),
                    })),
                },
            },
        },
        ...errorResponses,
    },
}), async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await convertAttributeValueType(db, { attributeId: id, ...body }, projectionRefresh(db));

    return ok(c, result);
});

export { app as adminAttributesTypedRoutes, projectionRefresh };
