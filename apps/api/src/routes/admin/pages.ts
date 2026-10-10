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
  listMatchingPageClaims,
} from "@scalius/core/modules/pages";
import { readMatchingCursor } from "@scalius/core/utils/bulk-matching";
import { matchingResultSchema, matchingSchema, requireOneSelection, type MatchingResult } from "../../schemas/bulk-matching";
import type { Database } from "@scalius/database/client";
import {
  createPageSchema,
  updatePageSchema,
  pageRevisionClaimSchema,
  pageRevisionClaimsSchema,
} from "@scalius/core/modules/pages/browser";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { dashboardReservedSegment } from "@scalius/shared/platform-config";
import { NotFoundError } from "../../utils/api-error";
import {
  successEnvelope,
  paginatedEnvelope,
  messageResponse,
  noContentResponse,
  errorResponses,
  conflictResponse,
} from "../../schemas/responses";
import { pageSchema } from "../../schemas/entities";

import { ok, created, noContent } from "../../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

const pageMutationSchema = z.object({ revision: z.number().int().min(1) });
const pageCreateResultSchema = pageMutationSchema.extend({ id: z.string() });
const pageRevisionBodySchema = pageRevisionClaimSchema.omit({ id: true });

/**
 * The pages and blog posts list's filter for "all matching" bulk actions.
 * The tab (Trash or not) is the action's own.
 */
const pageMatchingSchema = matchingSchema(z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(["draft", "scheduled", "published"]).optional(),
  contentType: z.enum(["page", "article"]).default("page"),
}).strict());
type PageMatching = z.infer<typeof pageMatchingSchema>;

/** A bulk body names its pages one way: the claims, or every page the filter matches. */
const pageSelectionSchema = z.object({
  pages: pageRevisionClaimsSchema.shape.pages.optional(),
  matching: pageMatchingSchema.optional(),
});
const pageBulkResult = {
  description: "Pages changed; with `matching`, where the next slice starts",
  content: { "application/json": { schema: successEnvelope(z.object({ matching: matchingResultSchema.optional() })) } },
};

/** Runs one bulk page write on the listed claims, or on one slice of the matching pages. */
async function runPageBulk(
  db: Database,
  body: { pages?: Array<{ id: string; expectedRevision: number }>; matching?: PageMatching },
  trashed: boolean,
  write: (claims: Array<{ id: string; expectedRevision: number }>) => Promise<void>,
): Promise<{ matching?: MatchingResult }> {
  requireOneSelection(body.pages, body.matching);
  if (!body.matching) {
    await write(body.pages!);
    return {};
  }
  const { filter, cursor } = body.matching;
  const slice = await listMatchingPageClaims(db, {
    search: filter.search || undefined,
    status: trashed ? undefined : filter.status,
    contentType: filter.contentType,
    showTrashed: trashed,
  }, readMatchingCursor(cursor));
  if (slice.claims.length > 0) await write(slice.claims);
  return { matching: { processed: slice.claims.length, skipped: 0, next: slice.next } };
}

// ── List Pages ──

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin - Pages"],
  summary: "List all pages",
  operationId: "dashboard.content.list",
  request: {
    query: z.object({
      page: z.coerce
        .number()
        .default(1)
        .openapi({ description: "Page number" }),
      limit: z.coerce
        .number()
        .max(100)
        .default(10)
        .openapi({ description: "Items per page" }),
      search: z
        .string()
        .optional()
        .default("")
        .openapi({ description: "Search term" }),
      trashed: z
        .string()
        .optional()
        .openapi({ description: "Show trashed items" }),
      status: z
        .enum(["draft", "scheduled", "published"])
        .optional()
        .openapi({ description: "Lifecycle status" }),
      contentType: z
        .enum(["page", "article"])
        .optional()
        .default("page")
        .openapi({ description: "Content type" }),
      sort: z
        .enum(["title", "createdAt", "updatedAt"])
        .optional()
        .default("updatedAt")
        .openapi({ description: "Sort field" }),
      order: z
        .enum(["asc", "desc"])
        .optional()
        .default("desc")
        .openapi({ description: "Sort order" }),
    }),
  },
  responses: {
    200: {
      description: "Page list with pagination",
      content: {
        "application/json": { schema: paginatedEnvelope("pages", pageSchema) },
      },
    },
    ...errorResponses,
  },
});

app.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const q = c.req.valid("query");
  const result = await listPages(db, {
    page: q.page,
    limit: q.limit,
    search: q.search || "",
    showTrashed: q.trashed === "true",
    status: q.status,
    contentType: q.contentType,
    sort: q.sort,
    order: q.order,
  });
  return ok(c, result);
});

// ── Create Page ──

const createPageRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin - Pages"],
  summary: "Create a page",
  operationId: "dashboard.content.create",
  request: {
    body: { content: { "application/json": { schema: createPageSchema } } },
  },
  responses: {
    201: {
      description: "Page created",
      content: {
        "application/json": { schema: successEnvelope(pageCreateResultSchema) },
      },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

/** The dashboard's first path segment is never a valid CMS page slug on a shared host. */
function reservedDashboardSlugs(env: Env): ReadonlySet<string> {
  const platform = env.PLATFORM_CONFIG;
  const segment = dashboardReservedSegment(platform?.dashboardUrl, platform?.storefrontUrl);
  return new Set(segment ? [segment] : []);
}

app.openapi(createPageRoute, async (c) => {
  const db = c.get("db");
  const result = await createPage(db, c.req.valid("json"), {
    canPublish: c.get("adminPermissions").has(PERMISSIONS.PAGES_PUBLISH),
    reservedSlugs: reservedDashboardSlugs(c.env),
  });

  return created(c, result);
});

// ── Bulk Delete Pages ──

const bulkDeleteRoute = createRoute({
  method: "post",
  path: "/bulk-delete",
  tags: ["Admin - Pages"],
  summary: "Bulk delete pages",
  operationId: "dashboard.content.bulk_delete",
  request: {
    body: {
      content: {
        "application/json": {
          schema: pageSelectionSchema.extend({
            permanent: z.boolean().default(false),
          }),
        },
      },
    },
  },
  responses: {
    200: pageBulkResult,
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(bulkDeleteRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  return ok(c, await runPageBulk(db, body, body.permanent, (claims) => bulkDeletePages(db, claims, body.permanent)));
});

// ── Bulk Publish Pages ──

const bulkPublishRoute = createRoute({
  method: "post",
  path: "/bulk-publish",
  tags: ["Admin - Pages"],
  summary: "Bulk publish pages",
  operationId: "dashboard.content.bulk_publish",
  request: {
    body: {
      content: { "application/json": { schema: pageSelectionSchema } },
    },
  },
  responses: {
    200: pageBulkResult,
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(bulkPublishRoute, async (c) => {
  const db = c.get("db");
  return ok(c, await runPageBulk(db, c.req.valid("json"), false, (claims) => bulkPublishPages(db, claims)));
});

// ── Bulk Unpublish Pages ──

const bulkUnpublishRoute = createRoute({
  method: "post",
  path: "/bulk-unpublish",
  tags: ["Admin - Pages"],
  summary: "Bulk unpublish pages",
  operationId: "dashboard.content.bulk_unpublish",
  request: {
    body: {
      content: { "application/json": { schema: pageSelectionSchema } },
    },
  },
  responses: {
    200: pageBulkResult,
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(bulkUnpublishRoute, async (c) => {
  const db = c.get("db");
  return ok(c, await runPageBulk(db, c.req.valid("json"), false, (claims) => bulkUnpublishPages(db, claims)));
});

// ── Bulk Restore Pages ──

const bulkRestoreRoute = createRoute({
  method: "post",
  path: "/bulk-restore",
  tags: ["Admin - Pages"],
  summary: "Bulk restore pages",
  operationId: "dashboard.content.bulk_restore",
  request: {
    body: {
      content: { "application/json": { schema: pageSelectionSchema } },
    },
  },
  responses: {
    200: pageBulkResult,
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(bulkRestoreRoute, async (c) => {
  const db = c.get("db");
  return ok(c, await runPageBulk(db, c.req.valid("json"), true, (claims) => restorePages(db, claims)));
});

// ── Restore Page ──

const restoreRoute = createRoute({
  method: "post",
  path: "/{id}/restore",
  tags: ["Admin - Pages"],
  summary: "Restore a soft-deleted page",
  operationId: "dashboard.content.restore",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: pageRevisionBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Page restored",
      content: { "application/json": { schema: messageResponse } },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(restoreRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  // Note: do NOT call getPageById here — it filters deletedAt IS NULL,
  // which would always 404 for soft-deleted pages being restored
  await restorePages(db, [
    { id, expectedRevision: c.req.valid("json").expectedRevision },
  ]);

  return ok(c, { message: "Page restored" });
});

// ── Get Page By ID ──

const getByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin - Pages"],
  summary: "Get a page by ID",
  operationId: "dashboard.content.get",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Page details",
      content: { "application/json": { schema: successEnvelope(pageSchema) } },
    },
    ...errorResponses,
  },
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
  operationId: "dashboard.content.update",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: updatePageSchema } } },
  },
  responses: {
    200: {
      description: "Page updated",
      content: {
        "application/json": { schema: successEnvelope(pageMutationSchema) },
      },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(updatePageRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const result = await updatePage(db, id, c.req.valid("json"), {
    canPublish: c.get("adminPermissions").has(PERMISSIONS.PAGES_PUBLISH),
    reservedSlugs: reservedDashboardSlugs(c.env),
  });

  return ok(c, result);
});

// ── Delete Page ──

const deletePageRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin - Pages"],
  summary: "Soft-delete a page",
  operationId: "dashboard.content.trash",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: pageRevisionBodySchema,
        },
      },
    },
  },
  responses: {
    204: noContentResponse,
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(deletePageRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  await deletePage(db, id, c.req.valid("json").expectedRevision);

  return noContent(c);
});

// ── Permanent Delete Page ──

const permanentDeleteRoute = createRoute({
  method: "delete",
  path: "/{id}/permanent",
  tags: ["Admin - Pages"],
  summary: "Permanently delete a page",
  operationId: "dashboard.content.permanently_delete",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: pageRevisionBodySchema,
        },
      },
    },
  },
  responses: {
    204: noContentResponse,
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(permanentDeleteRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  await bulkDeletePages(
    db,
    [{ id, expectedRevision: c.req.valid("json").expectedRevision }],
    true,
  );

  return noContent(c);
});

export { app as adminPageRoutes };
