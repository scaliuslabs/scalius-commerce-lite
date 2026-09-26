// Admin brand routes: list, picker options, detail and revision-guarded
// writes. Every write is buyer-visible (brand page, product brand line, feed
// and JSON-LD brand); database triggers advance the affected dependencies.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  createBrand,
  getBrandById,
  listBrandOptions,
  listBrands,
  permanentlyDeleteBrands,
  restoreBrands,
  trashBrands,
  updateBrand,
  updateBrandStatus,
  BRAND_OPTIONS_LIMIT,
} from "@scalius/core/modules/brands";
import {
  BRAND_BATCH_LIMIT,
  brandIdSchema,
  brandRevisionClaimSchema,
  brandStatusSchema,
  createBrandSchema,
  updateBrandSchema,
  updateBrandStatusSchema,
} from "@scalius/core/modules/brands/browser";
import { ok, created } from "../../utils/api-response";
import { NotFoundError } from "../../utils/api-error";
import {
  conflictResponse,
  errorResponses,
  paginatedEnvelope,
  successEnvelope,
} from "../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();
const TAGS = ["Admin - Brands"];

const logoSchema = z.object({
  mediaId: z.string(),
  url: z.string(),
  alt: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});

const brandRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: brandStatusSchema,
  sortOrder: z.number().int(),
  revision: z.number().int().min(1),
  noIndex: z.boolean(),
  excludeFromSitemap: z.boolean(),
  productCount: z.number().int().min(0),
  logo: logoSchema.nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});

const brandDetailSchema = brandRowSchema.extend({
  description: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  canonicalPath: z.string().nullable(),
  listingTemplate: z.string().nullable(),
  logoMediaId: z.string().nullable(),
});

const mutationResultSchema = z.object({ revision: z.number().int().min(1), status: brandStatusSchema });
const claimsBodySchema = z.object({
  brands: z.array(brandRevisionClaimSchema).min(1).max(BRAND_BATCH_LIMIT),
});
const idParams = z.object({ id: brandIdSchema });

// ── Reads ──

const listRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "dashboard.brands.list",
  tags: TAGS,
  summary: "List brands",
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).max(100_000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().max(100).optional(),
      status: brandStatusSchema.optional(),
      trashed: z.enum(["true", "false"]).optional(),
      sort: z.enum(["name", "sortOrder", "createdAt", "updatedAt"]).optional().default("updatedAt"),
      order: z.enum(["asc", "desc"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "Brands with pagination",
      content: { "application/json": { schema: paginatedEnvelope("brands", brandRowSchema) } },
    },
    ...errorResponses,
  },
});

app.openapi(listRoute, async (c) => {
  const query = c.req.valid("query");
  return ok(c, await listBrands(c.get("db"), {
    page: query.page,
    limit: query.limit,
    search: query.search,
    status: query.status,
    showTrashed: query.trashed === "true",
    sort: query.sort,
    order: query.order,
  }));
});

const formOptionsRoute = createRoute({
  method: "get",
  path: "/form-options",
  operationId: "dashboard.brands.form_options",
  tags: TAGS,
  summary: "Search live brands for a brand picker",
  request: {
    query: z.object({ search: z.string().trim().max(100).optional() }),
  },
  responses: {
    200: {
      description: "Live brands in name order",
      content: { "application/json": { schema: successEnvelope(z.object({
        brands: z.array(z.object({ id: z.string(), name: z.string(), status: brandStatusSchema })).max(BRAND_OPTIONS_LIMIT),
      })) } },
    },
    ...errorResponses,
  },
});

app.openapi(formOptionsRoute, async (c) => {
  return ok(c, { brands: await listBrandOptions(c.get("db"), { search: c.req.valid("query").search }) });
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "dashboard.brands.get",
  tags: TAGS,
  summary: "Get a brand",
  request: { params: idParams },
  responses: {
    200: {
      description: "Brand",
      content: { "application/json": { schema: successEnvelope(brandDetailSchema) } },
    },
    ...errorResponses,
  },
});

app.openapi(getRoute, async (c) => {
  const brand = await getBrandById(c.get("db"), c.req.valid("param").id);
  if (!brand) throw new NotFoundError("Brand not found");
  return ok(c, brand);
});

// ── Writes ──

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  operationId: "dashboard.brands.create",
  tags: TAGS,
  summary: "Create a brand",
  request: { body: { content: { "application/json": { schema: createBrandSchema } } } },
  responses: {
    201: {
      description: "Brand created",
      content: { "application/json": { schema: successEnvelope(z.object({
        id: z.string(),
        slug: z.string(),
        revision: z.number().int().min(1),
        status: brandStatusSchema,
      })) } },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(createRouteDef, async (c) => {
  const result = await createBrand(c.get("db"), c.req.valid("json"));

  return created(c, result);
});

const updateRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "dashboard.brands.update",
  tags: TAGS,
  summary: "Update a brand",
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: updateBrandSchema } } },
  },
  responses: {
    200: {
      description: "Brand updated",
      content: { "application/json": { schema: successEnvelope(mutationResultSchema) } },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(updateRoute, async (c) => {
  const result = await updateBrand(c.get("db"), c.req.valid("param").id, c.req.valid("json"));

  return ok(c, result);
});

const statusRoute = createRoute({
  method: "patch",
  path: "/{id}/status",
  operationId: "dashboard.brands.set_status",
  tags: TAGS,
  summary: "Publish or unpublish a brand",
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: updateBrandStatusSchema } } },
  },
  responses: {
    200: {
      description: "Brand status changed",
      content: { "application/json": { schema: successEnvelope(mutationResultSchema) } },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(statusRoute, async (c) => {
  const result = await updateBrandStatus(c.get("db"), c.req.valid("param").id, c.req.valid("json"));

  return ok(c, result);
});

function claimsRoute(
  path: string,
  operationId: string,
  summary: string,
  run: typeof trashBrands,
) {
  const route = createRoute({
    method: "post",
    path,
    operationId,
    tags: TAGS,
    summary,
    request: { body: { content: { "application/json": { schema: claimsBodySchema } } } },
    responses: {
      200: {
        description: summary,
        content: { "application/json": { schema: successEnvelope(z.object({ count: z.number().int().min(1) })) } },
      },
      ...errorResponses,
      409: conflictResponse,
    },
  });
  app.openapi(route, async (c) => {
    const { brands } = c.req.valid("json");
    await run(c.get("db"), brands);

    return ok(c, { count: brands.length });
  });
}

claimsRoute("/trash", "dashboard.brands.trash", "Move brands to trash", trashBrands);
claimsRoute("/restore", "dashboard.brands.restore", "Restore brands from trash", restoreBrands);
claimsRoute("/delete-permanently", "dashboard.brands.delete_permanently", "Permanently delete brands in trash", permanentlyDeleteBrands);

export { app as adminBrandRoutes };
