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
    messageResponse,
    noContentResponse,
} from "../../schemas/responses";
import { attributeSchema } from "../../schemas/entities";
import { invalidateApiAndScheduleStorefrontGroups } from "../../utils/cache-invalidation";
const app = new OpenAPIHono<{ Bindings: Env }>();
const ATTRIBUTE_CACHE_GROUPS = ["attributes", "products"] as const;
const ATTRIBUTE_STOREFRONT_HTML_PATHS = ["/search"] as const;

async function invalidateAttributeCaches(c: {
    env?: Env;
    executionCtx?: ExecutionContext;
}) {
    await invalidateApiAndScheduleStorefrontGroups(ATTRIBUTE_CACHE_GROUPS, c, {
        htmlPaths: ATTRIBUTE_STOREFRONT_HTML_PATHS,
    });
}

// ── List Attributes ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Attributes"],
    summary: "List all product attributes",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().max(500).default(10).openapi({ description: "Items per page (max 500 for selector dropdowns)" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            sort: z.string().optional().default("name").openapi({ description: "Sort field" }),
            order: z.string().optional().default("asc").openapi({ description: "Sort order" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" })
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
        sort: (query.sort || "name") as string,
        order: (query.order || "asc") as "asc" | "desc",
        showTrashed: query.trashed === "true",
    });
    return ok(c, result);
});

// ── Create Attribute ──

const createAttributeRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Attributes"],
    summary: "Create a product attribute",
    request: {
        body: { content: { "application/json": { schema: createAttributeSchema } } }
    },
    responses: {
        201: {
            description: "Attribute created",
            content: { "application/json": { schema: successEnvelope(z.object({ attribute: attributeSchema }) as z.ZodTypeAny) } },
        },
        ...errorResponses,
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
    tags: ["Admin - Attributes"],
    summary: "Update a product attribute",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateAttributeSchema } } }
    },
    responses: {
        200: {
            description: "Attribute updated",
            content: { "application/json": { schema: successEnvelope(z.object({ attribute: attributeSchema }) as z.ZodTypeAny) } },
        },
        ...errorResponses,
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
    tags: ["Admin - Attributes"],
    summary: "Soft-delete a product attribute",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
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
    tags: ["Admin - Attributes"],
    summary: "List all unique values for an attribute",
    request: {
        params: z.object({ id: z.string() }),
        query: z.object({
            search: z.string().optional().openapi({ description: "Filter values" }),
            sort: z.string().optional().default("desc").openapi({ description: "Sort order" }),
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().max(100).default(20).openapi({ description: "Items per page" })
        })
    },
    responses: {
        200: {
            description: "Attribute values",
            content: { "application/json": { schema: successEnvelope(z.object({
                attributeId: z.string(),
                attributeName: z.string(),
                values: z.array(z.object({
                    value: z.string(),
                    productCount: z.number(),
                    createdAt: z.union([z.string(), z.number()]),
                    isPreset: z.boolean(),
                    sampleProducts: z.array(z.string()),
                })),
                totalValues: z.number(),
                page: z.number(),
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
