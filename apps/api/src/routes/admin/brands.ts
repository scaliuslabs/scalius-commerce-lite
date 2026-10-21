// Admin brand routes: list, picker options, detail and revision-guarded
// writes. Every write is buyer-visible (brand page, product brand line, feed
// and JSON-LD brand); database triggers advance the affected dependencies.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { nullableIsoTimestampSchema } from "../../schemas/timestamps";
import {
  createBrand,
  getBrandById,
  getBrandsByIds,
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
import { brands as brandsTable } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { inArray } from "drizzle-orm";
import { planLimits } from "@scalius/shared/plan-limits";
import { idempotencyKeyHeaderSchema } from "./idempotency";
import { batchItemKeySchema, batchRequestSchema, batchResultSchema, runBatchCreate, type BatchCreateData } from "./resources-batch";
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
  createdAt: nullableIsoTimestampSchema,
  updatedAt: nullableIsoTimestampSchema,
  deletedAt: nullableIsoTimestampSchema,
});

/** A brand as `brands.get` reads it and every brand write answers it (`{ brand }`). */
const BrandResource = brandRowSchema.extend({
  description: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  canonicalPath: z.string().nullable(),
  listingTemplate: z.string().nullable(),
  logoMediaId: z.string().nullable(),
}).openapi("BrandResource");

type BrandResourceData = NonNullable<Awaited<ReturnType<typeof getBrandById>>>;

const brandEnvelope = successEnvelope(z.object({ brand: BrandResource }));

/** The brand as it is now, in the trash or not. */
async function readBrand(db: Database, id: string): Promise<BrandResourceData> {
  const brand = await getBrandById(db, id);
  if (!brand) throw new NotFoundError("Brand not found");
  return brand;
}
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
      content: { "application/json": { schema: brandEnvelope } },
    },
    ...errorResponses,
  },
});

app.openapi(getRoute, async (c) => {
  return ok(c, { brand: await readBrand(c.get("db"), c.req.valid("param").id) });
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
      description: "The new brand",
      content: { "application/json": { schema: brandEnvelope } },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(createRouteDef, async (c) => {
  const db = c.get("db");
  const { id } = await createBrand(db, c.req.valid("json"));
  return created(c, { brand: await readBrand(db, id) });
});

// Batch create (stable app API, resources-batch.ts): many brands per call,
// each item the create body plus its `key`, replayed per item (its id derives from the key).
// Bound: plan value `batchCreates.brands` (Free 19, Paid 50). A call costs 2
// D1 calls and each brand 2: nineteen brands are 40 D1 calls, 46 of Free's 50
// with the platform's own (resources-batch.d1.test.ts).
const batchCreateBody = batchRequestSchema(
  createBrandSchema.safeExtend({ key: batchItemKeySchema }),
  planLimits("paid").batchCreates.brands,
);

const batchCreateRoute = createRoute({
  method: "post",
  path: "/batch",
  operationId: "dashboard.brands.batch_create",
  tags: TAGS,
  summary: "Create many brands in one call",
  description: "Creates up to the plan's bound of brands (50 on Paid, fewer on Free), each the body of `brands.create` plus a `key` of yours. Items run in order and one refusal never stops the others: each result is `created`, `replayed` (that key already created its brand earlier; nothing is created again) or `failed` with the refusal's code. Each result carries the brand as `brands.get` reads it. Send an Idempotency-Key too: a repeat of the whole request returns the first response.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: batchCreateBody } } },
  },
  responses: {
    200: { description: "One result per item, in request order", content: { "application/json": { schema: successEnvelope(batchResultSchema("brand", BrandResource)) } } },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(batchCreateRoute, async (c) => {
  const db = c.get("db");
  const { items } = c.req.valid("json");
  const { data } = await runBatchCreate(c, {
    operationId: "dashboard.brands.batch_create",
    noun: "brand",
    plural: "brands",
    items,
    bound: planLimits().batchCreates.brands,
    idPrefix: "brd_",
    create: ({ key: _key, ...body }, id) => createBrand(db, body, { id }),
    existing: async (ids) => new Set((await db.select({ id: brandsTable.id }).from(brandsTable).where(inArray(brandsTable.id, [...ids]))).map((row) => row.id)),
    readRefs: async (ids) => new Map((await getBrandsByIds(db, ids)).flatMap((brand) => (brand.deletedAt ? [] : [[brand.id, brand] as const]))),
  });
  return ok(c, data as BatchCreateData<"brand", BrandResourceData>);
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
      description: "The brand as updated",
      content: { "application/json": { schema: brandEnvelope } },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(updateRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  await updateBrand(db, id, c.req.valid("json"));
  return ok(c, { brand: await readBrand(db, id) });
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
      description: "The brand with its new status",
      content: { "application/json": { schema: brandEnvelope } },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(statusRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  await updateBrandStatus(db, id, c.req.valid("json"));
  return ok(c, { brand: await readBrand(db, id) });
});

// Trash and restore answer the brands they moved, as `brands.get` reads them.
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
        description: "The brands, in request order",
        content: { "application/json": { schema: successEnvelope(z.object({ brands: z.array(BrandResource).max(BRAND_BATCH_LIMIT) })) } },
      },
      ...errorResponses,
      409: conflictResponse,
    },
  });
  app.openapi(route, async (c) => {
    const db = c.get("db");
    const { brands } = c.req.valid("json");
    await run(db, brands);
    return ok(c, { brands: await getBrandsByIds(db, brands.map((claim) => claim.id)) });
  });
}

claimsRoute("/trash", "dashboard.brands.trash", "Move brands to trash", trashBrands);
claimsRoute("/restore", "dashboard.brands.restore", "Restore brands from trash", restoreBrands);

// Permanent delete answers how many brands it removed (they no longer exist).
function deleteRoute(
  path: string,
  operationId: string,
  summary: string,
  run: typeof permanentlyDeleteBrands,
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

deleteRoute("/delete-permanently", "dashboard.brands.delete_permanently", "Permanently delete brands in trash", permanentlyDeleteBrands);

export { app as adminBrandRoutes };
