// src/server/routes/admin/attributes.ts
// Admin OpenAPI routes for product attributes.
// Thin HTTP layer: validate → delegate to core → respond.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    createAttributeSchema,
    updateAttributeSchema,
    bulkActionSchema,
    addValueSchema,
    updateValueSchema,
    deleteValueSchema,
} from "@scalius/core/modules/attributes/attributes.validation";
import {
    listAttributes,
    listAttributeAgentSummaries,
    createAttribute,
    updateAttribute,
    deleteAttribute,
    permanentlyDeleteAttribute,
    bulkDeleteAttributes,
    bulkRestoreAttributes,
    restoreAttribute,
    listAttributeValues,
    addAttributeValue,
    renameAttributeValue,
    deleteAttributeValue,
} from "@scalius/core/modules/attributes/attributes.service";
import { ok, created, noContent } from "../../utils/api-response";
import {
    successEnvelope,
    paginatedEnvelope,
    errorResponses,
    conflictResponse,
    messageResponse,
    noContentResponse,
} from "../../schemas/responses";
import { attributeSchema } from "../../schemas/entities";
import {
    invalidateApiAndScheduleStorefrontGroups,
    type WaitUntilExecutionContext,
} from "../../utils/cache-invalidation";
const app = new OpenAPIHono<{ Bindings: Env }>();
const ATTRIBUTE_CACHE_GROUPS = ["attributes", "products"] as const;
const attributeMutationResultSchema = z.object({
    id: z.string().max(180),
    name: z.string().max(100),
    slug: z.string().max(100),
    filterable: z.boolean(),
});
const attributeAgentSummarySchema = attributeMutationResultSchema.extend({
    deletedAt: z.union([z.string(), z.number()]).nullable(),
});

async function invalidateAttributeCaches(c: {
    env?: Env;
    executionCtx?: WaitUntilExecutionContext;
}) {
    await invalidateApiAndScheduleStorefrontGroups(ATTRIBUTE_CACHE_GROUPS, c);
}

// ── List Attributes ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.attributes.list",
    tags: ["Admin - Attributes"],
    summary: "List all product attributes",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().int().min(1).max(500).default(10).openapi({ description: "Items per page (max 500)" }),
            search: z.string().trim().max(120).optional().default("").openapi({ description: "Search term" }),
            sort: z.enum(["name", "slug", "filterable", "createdAt", "updatedAt"]).optional().default("name").openapi({ description: "Sort field" }),
            order: z.enum(["asc", "desc"]).optional().default("asc").openapi({ description: "Sort order" }),
            ids: z.string().max(9000).optional().openapi({ description: "Comma-separated attribute IDs (max 90)" }),
            trashed: z.enum(["true", "false"]).optional().openapi({ description: "Show trashed items" })
        })
    },
    responses: {
        200: {
            description: "Attribute list with pagination",
            content: { "application/json": { schema: paginatedEnvelope("attributes", attributeSchema.extend({ valueCount: z.number() })) } },
        },
        ...errorResponses,
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await listAttributes(db, {
        page: query.page,
        limit: query.limit,
        search: query.search || "",
        sort: query.sort || "name",
        order: query.order || "asc",
        ids: query.ids?.split(","),
        showTrashed: query.trashed === "true",
    });
    return ok(c, result);
});

const listAgentSummariesRoute = createRoute({
    method: "get",
    path: "/summaries",
    operationId: "dashboard.attributes.list_summaries",
    tags: ["Admin - Attributes"],
    summary: "List bounded attribute summaries",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1),
            limit: z.coerce.number().int().min(1).max(50).default(20),
            search: z.string().trim().max(120).optional().default(""),
            sort: z.enum(["name", "slug", "filterable", "createdAt", "updatedAt"]).optional().default("name"),
            order: z.enum(["asc", "desc"]).optional().default("asc"),
            ids: z.string().max(9000).optional(),
            trashed: z.enum(["true", "false"]).optional(),
        }),
    },
    responses: {
        200: {
            description: "Bounded attribute summaries with pagination",
            content: { "application/json": { schema: paginatedEnvelope("attributes", attributeAgentSummarySchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(listAgentSummariesRoute, async (c) => {
    const query = c.req.valid("query");
    return ok(c, await listAttributeAgentSummaries(c.get("db"), {
        page: query.page,
        limit: query.limit,
        search: query.search,
        sort: query.sort,
        order: query.order,
        ids: query.ids?.split(","),
        showTrashed: query.trashed === "true",
    }));
});

// ── Create Attribute ──

const createAttributeRoute = createRoute({
    method: "post",
    path: "/",
    operationId: "dashboard.attributes.create",
    tags: ["Admin - Attributes"],
    summary: "Create a product attribute",
    request: {
        body: { content: { "application/json": { schema: createAttributeSchema } } }
    },
    responses: {
        201: {
            description: "Attribute created",
            content: { "application/json": { schema: successEnvelope(z.object({ attribute: attributeMutationResultSchema })) } },
        },
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(createAttributeRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const result = await createAttribute(db, data);
    await invalidateAttributeCaches(c);
    return created(c, result);
});

// ── Update Attribute ──

const updateAttributeRoute = createRoute({
    method: "put",
    path: "/{id}",
    operationId: "dashboard.attributes.update",
    tags: ["Admin - Attributes"],
    summary: "Update a product attribute",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateAttributeSchema } } }
    },
    responses: {
        200: {
            description: "Attribute updated",
            content: { "application/json": { schema: successEnvelope(z.object({ attribute: attributeMutationResultSchema })) } },
        },
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(updateAttributeRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    const result = await updateAttribute(db, id, data);
    await invalidateAttributeCaches(c);
    return ok(c, result);
});

// ── Delete Attribute ──

const deleteAttributeRoute = createRoute({
    method: "delete",
    path: "/{id}",
    operationId: "dashboard.attributes.trash",
    tags: ["Admin - Attributes"],
    summary: "Soft-delete a product attribute",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(deleteAttributeRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteAttribute(db, id);
    await invalidateAttributeCaches(c);
    return noContent(c);
});

// ── Permanent Delete Attribute ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    operationId: "dashboard.attributes.delete_permanently",
    tags: ["Admin - Attributes"],
    summary: "Permanently delete a product attribute",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await permanentlyDeleteAttribute(db, id);
    await invalidateAttributeCaches(c);
    return noContent(c);
});

// ── Bulk Delete Attributes ──

const bulkDeleteRoute = createRoute({
    method: "post",
    path: "/bulk-delete",
    operationId: "dashboard.attributes.bulk_delete",
    tags: ["Admin - Attributes"],
    summary: "Bulk delete attributes",
    request: {
        body: { content: { "application/json": { schema: bulkActionSchema } } }
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { ids, permanent } = c.req.valid("json");
    await bulkDeleteAttributes(db, ids, permanent);
    await invalidateAttributeCaches(c);
    return noContent(c);
});

// ── Bulk Restore Attributes ──

const bulkRestoreRoute = createRoute({
    method: "post",
    path: "/bulk-restore",
    operationId: "dashboard.attributes.bulk_restore",
    tags: ["Admin - Attributes"],
    summary: "Bulk restore attributes",
    request: {
        body: { content: { "application/json": { schema: bulkActionSchema } } }
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkRestoreRoute, async (c) => {
    const db = c.get("db");
    const { ids } = c.req.valid("json");
    await bulkRestoreAttributes(db, ids);
    await invalidateAttributeCaches(c);
    return noContent(c);
});

// ── Restore Attribute ──

const restoreRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    operationId: "dashboard.attributes.restore",
    tags: ["Admin - Attributes"],
    summary: "Restore a soft-deleted product attribute",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Attribute restored",
            content: { "application/json": { schema: messageResponse } },
        },
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(restoreRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await restoreAttribute(db, id);
    await invalidateAttributeCaches(c);
    return ok(c, { message: "Attribute restored" });
});

// ── List Attribute Values ──

const listValuesRoute = createRoute({
    method: "get",
    path: "/{id}/values",
    operationId: "dashboard.attribute_values.list",
    tags: ["Admin - Attributes"],
    summary: "List all unique values for an attribute",
    request: {
        params: z.object({ id: z.string() }),
        query: z.object({
            search: z.string().trim().max(120).optional().openapi({ description: "Filter values" }),
            sort: z.enum(["asc", "desc"]).optional().default("desc").openapi({ description: "Sort order" }),
            page: z.coerce.number().int().min(1).default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().int().min(1).max(50).default(20).openapi({ description: "Items per page (max 50)" })
        })
    },
    responses: {
        200: {
            description: "Attribute values",
            content: { "application/json": { schema: successEnvelope(z.object({
                attributeId: z.string().max(180),
                attributeName: z.string().max(100),
                values: z.array(z.object({
                    value: z.string().max(100),
                    productCount: z.number(),
                    createdAt: z.union([z.string(), z.number()]),
                    isPreset: z.boolean(),
                    sampleProducts: z.array(z.string().max(100)).max(5),
                })).max(50),
                totalValues: z.number(),
                totalProducts: z.number(),
                page: z.number(),
                limit: z.number(),
                totalPages: z.number(),
            })) } },
        },
        ...errorResponses,
    }
});

app.openapi(listValuesRoute, async (c) => {
    const db = c.get("db");
    const { id: attributeId } = c.req.valid("param");
    const query = c.req.valid("query");
    const result = await listAttributeValues(db, attributeId, {
        search: query.search,
        sort: query.sort || "desc",
        page: query.page,
        limit: query.limit,
    });
    return ok(c, result);
});

// ── Add Attribute Value ──

const addValueRoute = createRoute({
    method: "post",
    path: "/{id}/values",
    operationId: "dashboard.attribute_values.create",
    tags: ["Admin - Attributes"],
    summary: "Add a preset value to an attribute",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: addValueSchema } } }
    },
    responses: {
        200: {
            description: "Value added",
            content: { "application/json": { schema: successEnvelope(z.object({})) } },
        },
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(addValueRoute, async (c) => {
    const db = c.get("db");
    const { id: attributeId } = c.req.valid("param");
    const { value } = c.req.valid("json");
    await addAttributeValue(db, attributeId, value);
    await invalidateAttributeCaches(c);
    return ok(c, {});
});

// ── Update Attribute Value ──

const updateValueRoute = createRoute({
    method: "put",
    path: "/{id}/values",
    operationId: "dashboard.attribute_values.rename",
    tags: ["Admin - Attributes"],
    summary: "Rename an attribute value across all products",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateValueSchema } } }
    },
    responses: {
        200: {
            description: "Value updated",
            content: { "application/json": { schema: messageResponse } },
        },
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(updateValueRoute, async (c) => {
    const db = c.get("db");
    const { id: attributeId } = c.req.valid("param");
    const { oldValue, newValue } = c.req.valid("json");
    await renameAttributeValue(db, attributeId, oldValue, newValue);
    await invalidateAttributeCaches(c);
    return ok(c, {
        message: `Value "${oldValue}" renamed to "${newValue}"`
    });
});

// ── Delete Attribute Value ──

const deleteValueRoute = createRoute({
    method: "delete",
    path: "/{id}/values",
    operationId: "dashboard.attribute_values.delete",
    tags: ["Admin - Attributes"],
    summary: "Delete an attribute value from all products",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: deleteValueSchema } } }
    },
    responses: {
        200: {
            description: "Value deleted",
            content: { "application/json": { schema: messageResponse } },
        },
        ...errorResponses,
    }
});

app.openapi(deleteValueRoute, async (c) => {
    const db = c.get("db");
    const { id: attributeId } = c.req.valid("param");
    const { value } = c.req.valid("json");
    await deleteAttributeValue(db, attributeId, value);
    await invalidateAttributeCaches(c);
    return ok(c, {
        message: `Value "${value}" deleted from all products`
    });
});

export { app as adminAttributesRoutes };
