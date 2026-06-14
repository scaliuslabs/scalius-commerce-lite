// src/server/routes/admin/pages.ts
// Admin OpenAPI routes for CMS pages.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    listPages,
    getPageById,
    createPage,
    updatePage,
    deletePage,
    bulkDeletePages,
    bulkPublishPages,
    bulkUnpublishPages,
    restorePages,
    createPageSchema,
    updatePageSchema
} from "@scalius/core/modules/pages";
import { NotFoundError } from "../../utils/api-error";
import {
    successEnvelope,
    paginatedEnvelope,
    messageResponse,
    idResponse,
    noContentResponse,
    errorResponses,
} from "../../schemas/responses";
import { pageSchema } from "../../schemas/entities";
import {
    invalidateGroups,
    purgeStorefrontForGroups,
} from "../../utils/cache-invalidation";

import { ok, created, noContent } from "../../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

const PAGE_CACHE_GROUPS = ["pages"];

async function invalidatePageCaches(c: { env: Env; executionCtx: ExecutionContext }): Promise<void> {
    await invalidateGroups(PAGE_CACHE_GROUPS, c.env?.CACHE);
    await purgeStorefrontForGroups(PAGE_CACHE_GROUPS, c.env);
}

// ── List Pages ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Pages"],
    summary: "List all pages",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().max(100).default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
            sort: z.string().optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.string().optional().default("desc").openapi({ description: "Sort order" })
        })
    },
    responses: {
        200: {
            description: "Page list with pagination",
            content: { "application/json": { schema: paginatedEnvelope("pages", pageSchema) } },
        },
        ...errorResponses,
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const q = c.req.valid("query");
    const result = await listPages(db, {
        page: q.page,
        limit: q.limit,
        search: q.search || "",
        showTrashed: q.trashed === "true",
        sort: q.sort as "title" | "createdAt" | "updatedAt" | "sortOrder" | undefined,
        order: q.order as "asc" | "desc" | undefined
    });
    return ok(c, result);
});

// ── Create Page ──

const createPageRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Pages"],
    summary: "Create a page",
    request: {
        body: { content: { "application/json": { schema: createPageSchema } } }
    },
    responses: {
        201: {
            description: "Page created",
            content: { "application/json": { schema: idResponse } },
        },
        ...errorResponses,
    }
});

app.openapi(createPageRoute, async (c) => {
    const db = c.get("db");
    const result = await createPage(db, c.req.valid("json"));
    await invalidatePageCaches(c);
    return created(c, result);
});

// ── Bulk Delete Pages ──

const bulkDeleteRoute = createRoute({
    method: "post",
    path: "/bulk-delete",
    tags: ["Admin - Pages"],
    summary: "Bulk delete pages",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        pageIds: z.array(z.string()),
                        permanent: z.boolean().default(false)
                    })
                }
            }
        }
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { pageIds, permanent } = c.req.valid("json");
    await bulkDeletePages(db, pageIds, permanent);
    await invalidatePageCaches(c);
    return noContent(c);
});

// ── Bulk Publish Pages ──

const bulkPublishRoute = createRoute({
    method: "post",
    path: "/bulk-publish",
    tags: ["Admin - Pages"],
    summary: "Bulk publish pages",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()) }) } } }
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkPublishRoute, async (c) => {
    const db = c.get("db");
    await bulkPublishPages(db, c.req.valid("json").ids);
    await invalidatePageCaches(c);
    return noContent(c);
});

// ── Bulk Unpublish Pages ──

const bulkUnpublishRoute = createRoute({
    method: "post",
    path: "/bulk-unpublish",
    tags: ["Admin - Pages"],
    summary: "Bulk unpublish pages",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()) }) } } }
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkUnpublishRoute, async (c) => {
    const db = c.get("db");
    await bulkUnpublishPages(db, c.req.valid("json").ids);
    await invalidatePageCaches(c);
    return noContent(c);
});

// ── Bulk Restore Pages ──

const bulkRestoreRoute = createRoute({
    method: "post",
    path: "/bulk-restore",
    tags: ["Admin - Pages"],
    summary: "Bulk restore pages",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()) }) } } }
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkRestoreRoute, async (c) => {
    const db = c.get("db");
    await restorePages(db, c.req.valid("json").ids);
    await invalidatePageCaches(c);
    return noContent(c);
});

// ── Restore Page ──

const restoreRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Pages"],
    summary: "Restore a soft-deleted page",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Page restored",
            content: { "application/json": { schema: messageResponse } },
        },
        ...errorResponses,
    }
});

app.openapi(restoreRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    // Note: do NOT call getPageById here — it filters deletedAt IS NULL,
    // which would always 404 for soft-deleted pages being restored
    await restorePages(db, [id]);
    await invalidatePageCaches(c);
    return ok(c, { message: "Page restored" });
});

// ── Get Page By ID ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Pages"],
    summary: "Get a page by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Page details",
            content: { "application/json": { schema: successEnvelope(pageSchema) } },
        },
        ...errorResponses,
    }
});

app.openapi(getByIdRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const page = await getPageById(db, id);
    if (!page) throw new NotFoundError("Page not found");
    return ok(c, page);
});

// ── Update Page ──

const updatePageRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Pages"],
    summary: "Update a page",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updatePageSchema } } }
    },
    responses: {
        200: {
            description: "Page updated",
            content: { "application/json": { schema: successEnvelope(z.object({})) } },
        },
        ...errorResponses,
    }
});

app.openapi(updatePageRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await updatePage(db, id, c.req.valid("json"));
    await invalidatePageCaches(c);
    return ok(c, {});
});

// ── Delete Page ──

const deletePageRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Pages"],
    summary: "Soft-delete a page",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(deletePageRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deletePage(db, id);
    await invalidatePageCaches(c);
    return noContent(c);
});

// ── Permanent Delete Page ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Pages"],
    summary: "Permanently delete a page",
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
    await bulkDeletePages(db, [id], true);
    await invalidatePageCaches(c);
    return noContent(c);
});

export { app as adminPageRoutes };
