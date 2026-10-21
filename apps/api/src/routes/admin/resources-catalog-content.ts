// Categories and collections in the stable app API (operation-registry/README.md),
// mounted at /admin/resources (/categories, /collections): the one resource
// shape each is read in (`CategoryResource`, `CollectionResource`), which every
// category and collection write answers too (`{ category }`, `{ collection }`).
// Lists page by cursor in (updatedAt, id) order (`updatedSince` starts a sync).
// The dashboard's own tree, editor sections and pickers stay its beta
// operations (`dashboard.categories.*`, `dashboard.collections.*`).
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { gte, inArray, isNotNull, isNull, eq, sql, type SQL } from "drizzle-orm";
import { categories, collections } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { categoryStatusSchema } from "@scalius/shared/category-publication";
import { normalizeCollectionConfig } from "@scalius/core/modules/collections/browser";
import { keysetOrderBy } from "@scalius/core/utils/keyset";
import { NotFoundError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { isoTimestampSchema, nullableIsoTimestampSchema } from "../../schemas/timestamps";
import { nextCursorSchema } from "../../utils/bounded-page";
import { epochSeconds, resourcePage, resourcePageQuery, updatedOrder } from "../../utils/resource-page";

const app = new OpenAPIHono<{ Bindings: Env }>();

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};
app.use("*", noStore);

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

// ─── Categories ──────────────────────────────────────────────────────────────

export const CategoryResource = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: categoryStatusSchema.describe("`published` is public; `draft` and `internal` are not."),
  revision: z.number().int().min(1).openapi({ description: "Send it as `expectedRevision` to change the category; every change advances it." }),
  parentId: z.string().nullable().openapi({ description: "The parent category; null at the top level." }),
  depth: z.number().int().min(0).max(3).openapi({ description: "0 at the top level, at most 3." }),
  description: z.string().nullable(),
  content: z.string().nullable().openapi({ description: "The category page's rich text below the products." }),
  imageUrl: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  canonicalPath: z.string().nullable(),
  noIndex: z.boolean(),
  excludeFromSitemap: z.boolean(),
  listingTemplate: z.string().nullable().openapi({ description: "A listing template id from the theme; null is the theme's default category listing." }),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  deletedAt: nullableIsoTimestampSchema.openapi({ description: "When it was moved to the trash; null when it is not in the trash." }),
}).openapi("CategoryResource");

export type CategoryResourceData = z.infer<typeof CategoryResource>;

const categoryColumns = {
  id: categories.id,
  name: categories.name,
  slug: categories.slug,
  status: categories.status,
  revision: categories.revision,
  parentId: categories.parentId,
  depth: categories.depth,
  description: categories.description,
  content: categories.content,
  imageUrl: categories.imageUrl,
  metaTitle: categories.metaTitle,
  metaDescription: categories.metaDescription,
  canonicalPath: categories.canonicalPath,
  noIndex: categories.noIndex,
  excludeFromSitemap: categories.excludeFromSitemap,
  listingTemplate: categories.listingTemplate,
  createdAt: categories.createdAt,
  updatedAt: categories.updatedAt,
  deletedAt: categories.deletedAt,
};

/** Categories by id (at most 90), in the trash or not, in the order asked; unknown ids are left out. */
export async function readCategoryResources(db: Database, ids: readonly string[]): Promise<CategoryResourceData[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await db.select(categoryColumns).from(categories).where(inArray(categories.id, unique)).all();
  const byId = new Map(rows.map((row) => [row.id, {
    ...row,
    depth: Number(row.depth),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: iso(row.deletedAt),
  } satisfies CategoryResourceData]));
  return unique.flatMap((id) => byId.get(id) ?? []);
}

/** One category as it is now, in the trash or not. */
export async function readCategoryResource(db: Database, id: string): Promise<CategoryResourceData> {
  const [category] = await readCategoryResources(db, [id]);
  if (!category) throw new NotFoundError("Category not found");
  return category;
}

const categoryParams = z.object({ id: z.string().trim().min(1).max(180) });

app.openapi(createRoute({
  operationId: "dashboard.resources.categories.get",
  method: "get",
  path: "/categories/{id}",
  tags: ["App API - Categories"],
  summary: "Get a category",
  description: "The category, in the trash or not (`deletedAt`), with the revision to change it at.",
  request: { params: categoryParams },
  responses: {
    200: { description: "The category", content: { "application/json": { schema: successEnvelope(z.object({ category: CategoryResource })) } } },
    ...errorResponses,
  },
}), async (c) => ok(c, { category: await readCategoryResource(c.get("db"), c.req.valid("param").id) }));

const ROOT_PARENT = "root";

const categoriesQuery = z.object({
  ...resourcePageQuery,
  parentId: z.string().trim().min(1).max(180).optional()
    .openapi({ description: `Only the direct children of this category; \`${ROOT_PARENT}\` lists the top level.` }),
  trashed: z.enum(["true", "false"]).optional().openapi({ description: "true lists trashed categories instead." }),
});

app.openapi(createRoute({
  operationId: "dashboard.resources.categories.list",
  method: "get",
  path: "/categories",
  tags: ["App API - Categories"],
  summary: "List categories, least recently updated first",
  description: "Categories (CategoryResource) in (updatedAt, id) order. Start a sync with updatedSince and follow nextCursor; parentId lists one level of the tree.",
  request: { query: categoriesQuery },
  responses: {
    200: { description: "A page of categories", content: { "application/json": { schema: successEnvelope(z.object({ categories: z.array(CategoryResource), nextCursor: nextCursorSchema })) } } },
    ...errorResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [query.trashed === "true" ? isNotNull(categories.deletedAt) : isNull(categories.deletedAt)];
  if (query.updatedSince) where.push(gte(sql`${categories.updatedAt}`, epochSeconds(query.updatedSince)));
  if (query.parentId === ROOT_PARENT) where.push(isNull(categories.parentId));
  else if (query.parentId) where.push(eq(categories.parentId, query.parentId));
  const order = updatedOrder(categories.updatedAt, categories.id);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => db.select({ id: categories.id }).from(categories).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: (ids) => readCategoryResources(db, ids),
  });
  return ok(c, { categories: page.items, nextCursor: page.nextCursor });
});

// ─── Collections ─────────────────────────────────────────────────────────────

export const CollectionResource = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable().openapi({ description: "The collection's handle (`@collection:<handle>` in templates); null only on a row written outside the dashboard." }),
  revision: z.number().int().min(1).openapi({ description: "Send it as `expectedRevision` to change the collection; every change advances it." }),
  isActive: z.boolean().openapi({ description: "Whether buyers see it." }),
  presentation: z.enum(["grid", "carousel"]),
  sortOrder: z.number().int(),
  config: z.object({
    source: z.enum(["manual", "dynamic"]).openapi({ description: "`manual`: exactly `productIds`; `dynamic`: the products of `categoryIds`." }),
    productIds: z.array(z.string()),
    categoryIds: z.array(z.string()),
    featuredProductId: z.string().nullable(),
    maxProducts: z.number().int().min(1).max(24),
    title: z.string(),
    subtitle: z.string(),
  }),
  description: z.string().nullable(),
  content: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  canonicalPath: z.string().nullable(),
  noIndex: z.boolean(),
  excludeFromSitemap: z.boolean(),
  listingTemplate: z.string().nullable().openapi({ description: "A listing template id from the theme; null is the theme's default collection listing." }),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  deletedAt: nullableIsoTimestampSchema.openapi({ description: "When it was moved to the trash; null when it is not in the trash." }),
}).openapi("CollectionResource");

export type CollectionResourceData = z.infer<typeof CollectionResource>;

type CollectionRow = typeof collections.$inferSelect;

/** A stored collection row as the resource. */
export function presentCollection(row: CollectionRow): CollectionResourceData {
  const config = normalizeCollectionConfig(row.config);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    revision: row.version,
    isActive: row.isActive,
    presentation: row.presentation,
    sortOrder: row.sortOrder,
    config: {
      source: config.source,
      productIds: config.productIds,
      categoryIds: config.categoryIds,
      featuredProductId: config.featuredProductId ?? null,
      maxProducts: config.maxProducts,
      title: config.title,
      subtitle: config.subtitle,
    },
    description: row.description,
    content: row.content,
    metaTitle: row.metaTitle,
    metaDescription: row.metaDescription,
    canonicalPath: row.canonicalPath,
    noIndex: row.noIndex,
    excludeFromSitemap: row.excludeFromSitemap,
    listingTemplate: row.listingTemplate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: iso(row.deletedAt),
  };
}

/** Collections by id (at most 90), in the trash or not, in the order asked; unknown ids are left out. */
export async function readCollectionResources(db: Database, ids: readonly string[]): Promise<CollectionResourceData[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await db.select().from(collections).where(inArray(collections.id, unique)).all();
  const byId = new Map(rows.map((row) => [row.id, presentCollection(row)]));
  return unique.flatMap((id) => byId.get(id) ?? []);
}

/** One collection as it is now, in the trash or not. */
export async function readCollectionResource(db: Database, id: string): Promise<CollectionResourceData> {
  const [collection] = await readCollectionResources(db, [id]);
  if (!collection) throw new NotFoundError("Collection not found");
  return collection;
}

const collectionParams = z.object({ id: z.string().trim().min(1).max(180) });

app.openapi(createRoute({
  operationId: "dashboard.resources.collections.get",
  method: "get",
  path: "/collections/{id}",
  tags: ["App API - Collections"],
  summary: "Get a collection",
  description: "The collection, in the trash or not (`deletedAt`), with its products or categories and the revision to change it at.",
  request: { params: collectionParams },
  responses: {
    200: { description: "The collection", content: { "application/json": { schema: successEnvelope(z.object({ collection: CollectionResource })) } } },
    ...errorResponses,
  },
}), async (c) => ok(c, { collection: await readCollectionResource(c.get("db"), c.req.valid("param").id) }));

const collectionsQuery = z.object({
  ...resourcePageQuery,
  trashed: z.enum(["true", "false"]).optional().openapi({ description: "true lists trashed collections instead." }),
});

app.openapi(createRoute({
  operationId: "dashboard.resources.collections.list",
  method: "get",
  path: "/collections",
  tags: ["App API - Collections"],
  summary: "List collections, least recently updated first",
  description: "Collections (CollectionResource) in (updatedAt, id) order. Start a sync with updatedSince and follow nextCursor.",
  request: { query: collectionsQuery },
  responses: {
    200: { description: "A page of collections", content: { "application/json": { schema: successEnvelope(z.object({ collections: z.array(CollectionResource), nextCursor: nextCursorSchema })) } } },
    ...errorResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [query.trashed === "true" ? isNotNull(collections.deletedAt) : isNull(collections.deletedAt)];
  if (query.updatedSince) where.push(gte(sql`${collections.updatedAt}`, epochSeconds(query.updatedSince)));
  const order = updatedOrder(collections.updatedAt, collections.id);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => db.select({ id: collections.id }).from(collections).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: (ids) => readCollectionResources(db, ids),
  });
  return ok(c, { collections: page.items, nextCursor: page.nextCursor });
});

export { app as adminResourceCatalogContentRoutes };
