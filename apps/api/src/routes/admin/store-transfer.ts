// Store migration routes: bounded, idempotent import batches (products,
// product images, customers, inventory counts) and paged CSV exports. The
// dashboard parses and maps files in the browser and sends normalized rows
// here; agents send the same JSON. Every batch is validated again with the
// shared schemas, may stop early (time or the Worker's query limit) and says
// how many items it processed, and is safe to send again.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  buildInventoryCsvPage,
  buildProductCsvPage,
  importCustomers,
  importInventory,
  importProductImages,
  importProducts,
  INVENTORY_EXPORT_PAGE_MAX,
  PRODUCT_EXPORT_PAGE_MAX,
} from "@scalius/core/modules/store-transfer";
import { productImageBatchSchema, productImportBatchSchema } from "@scalius/shared/store-transfer/products";
import { customerImportBatchSchema } from "@scalius/shared/store-transfer/customers";
import { inventoryImportBatchSchema } from "@scalius/shared/store-transfer/inventory";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { ok } from "../../utils/api-response";
import { AppError } from "../../utils/api-error";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { importMediaFromUrl } from "./media-url-import";
import { notificationSender } from "../../background/notification-sender";

/** Largest import request body (the agent manifest declares the same ceiling). */
export const IMPORT_REQUEST_MAX_BYTES = 1024 * 1024;

type Ctx = { get: (key: string) => unknown; req: { header: (name: string) => string | undefined } };
const staffId = (c: Ctx) => (c.get("user") as { id?: string } | undefined)?.id ?? null;
const permissionsOf = (c: Ctx): ReadonlySet<string> => (c.get("adminPermissions") as ReadonlySet<string> | undefined) ?? new Set();

/** The permissions a batch mode needs beyond the route's own check. */
export function requireImportPermissions(c: Ctx, needed: readonly string[]): void {
  const granted = permissionsOf(c);
  const missing = needed.filter((permission) => !granted.has(permission));
  if (missing.length > 0) {
    throw new AppError(403, "FORBIDDEN", `This import needs the ${missing.join(" and ")} permission${missing.length > 1 ? "s" : ""}.`);
  }
}

const PRODUCT_MODE_PERMISSIONS: Record<"create" | "upsert" | "price", readonly string[]> = {
  create: [PERMISSIONS.PRODUCTS_CREATE],
  upsert: [PERMISSIONS.PRODUCTS_CREATE, PERMISSIONS.PRODUCTS_EDIT],
  price: [PERMISSIONS.PRODUCTS_EDIT],
};

const CUSTOMER_MODE_PERMISSIONS: Record<"create" | "upsert", readonly string[]> = {
  create: [PERMISSIONS.CUSTOMERS_CREATE],
  upsert: [PERMISSIONS.CUSTOMERS_CREATE, PERMISSIONS.CUSTOMERS_EDIT],
};

function assertBodySize(c: Ctx): void {
  const length = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(length) && length > IMPORT_REQUEST_MAX_BYTES) {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", `Send at most ${IMPORT_REQUEST_MAX_BYTES} bytes per import request; split the batch.`);
  }
}

const issueSchema = z.object({
  code: z.string(),
  message: z.string(),
  variantIndex: z.number().int().optional(),
  field: z.string().optional(),
});

const batchProgress = {
  processed: z.number().int().openapi({ description: "Items handled. When fewer than sent, send the rest again." }),
  stoppedEarly: z.boolean(),
};

const productResultSchema = z.object({
  ref: z.string(),
  status: z.enum(["created", "updated", "unchanged", "skipped", "failed", "would_create", "would_update", "would_skip"]),
  productId: z.string().nullable(),
  slug: z.string().nullable(),
  aggregateRevision: z.number().int().nullable(),
  issues: z.array(issueSchema),
});

const productBatchResponseSchema = z.object({
  results: z.array(productResultSchema),
  ...batchProgress,
  references: z.object({
    brandsToCreate: z.array(z.string()),
    categoriesToCreate: z.array(z.string()),
    attributesToCreate: z.array(z.string()),
  }),
  notes: z.array(z.string()),
});

const imageResultSchema = z.object({
  productId: z.string(),
  aggregateRevision: z.number().int().nullable(),
  error: z.string().nullable(),
  images: z.array(z.object({
    url: z.string(),
    status: z.enum(["attached", "already_attached", "failed", "pending"]),
    mediaId: z.string().nullable(),
    message: z.string().nullable(),
  })),
});

const customerResultSchema = z.object({
  ref: z.string(),
  status: z.enum(["created", "updated", "unchanged", "skipped", "failed", "would_create", "would_update", "would_skip"]),
  customerId: z.string().nullable(),
  subscribed: z.array(z.enum(["email", "sms", "whatsapp"])),
  issues: z.array(issueSchema),
});

const inventoryResultSchema = z.object({
  ref: z.string(),
  status: z.enum(["updated", "unchanged", "failed", "would_update", "would_skip"]),
  sku: z.string(),
  variantId: z.string().nullable(),
  location: z.object({ id: z.string(), name: z.string() }).nullable(),
  previousOnHand: z.number().int().nullable(),
  onHand: z.number().int().nullable(),
  issues: z.array(issueSchema),
});

const importApp = new OpenAPIHono<{ Bindings: Env }>();

// Before the body is parsed: an oversized batch is refused without reading it.
importApp.use("*", async (c, next) => {
  assertBodySize(c);
  await next();
});

const productsRoute = createRoute({
  operationId: "dashboard.import.products_batch",
  method: "post",
  path: "/products",
  tags: ["Admin - Import and export"],
  summary: "Import a batch of products",
  description: "Creates (mode `create`), creates or updates (mode `upsert`, matched by handle, then SKU) or reprices (mode `price`, matched by SKU) up to 50 normalized products through the product editor's own services. "
    + "Nothing missing from a row is removed; stock of existing SKUs is left to the inventory import. `dryRun: true` reports each item's action and the aggregate revision it saw; send that back as `expected` and the write is refused if the product changed since. "
    + "Re-sending the same items is a no-op. When `processed` is less than the items sent, send the rest again. Images are attached afterwards with dashboard.import.product_images_batch.",
  request: { body: { required: true, content: { "application/json": { schema: productImportBatchSchema } } } },
  responses: {
    200: { description: "What happened to each item", content: { "application/json": { schema: successEnvelope(productBatchResponseSchema) } } },
    ...errorResponses,
  },
});

importApp.openapi(productsRoute, async (c) => {
  assertBodySize(c);
  const batch = c.req.valid("json");
  requireImportPermissions(c, PRODUCT_MODE_PERMISSIONS[batch.mode]);
  // A file's costs per item are written only by staff who can see costs.
  if (batch.items.some((item) => item.variants.some((variant) => variant.cost != null))) {
    requireImportPermissions(c, [PERMISSIONS.PRODUCTS_VIEW_COSTS]);
  }
  // New SKUs' starting quantities are stock changes (a reprice never touches stock).
  if (batch.mode !== "price" && batch.items.some((item) => item.variants.some((variant) => (variant.stock ?? 0) > 0))) {
    requireImportPermissions(c, [PERMISSIONS.PRODUCTS_ADJUST_STOCK]);
  }
  const granted = permissionsOf(c);
  return ok(c, await importProducts(c.get("db"), batch, {
    actorId: staffId(c),
    rights: {
      // Brands are managed with category permissions (see the brand routes).
      brands: granted.has(PERMISSIONS.CATEGORIES_CREATE),
      categories: granted.has(PERMISSIONS.CATEGORIES_CREATE),
      attributes: granted.has(PERMISSIONS.ATTRIBUTES_CREATE),
    },
  }));
});

const productImagesRoute = createRoute({
  operationId: "dashboard.import.product_images_batch",
  method: "post",
  path: "/product-images",
  tags: ["Admin - Import and export"],
  summary: "Attach remote images to imported products",
  description: "Downloads each image (public HTTPS only, through the guarded media URL import) once per store, names the media after its URL, and appends the new ones to the product under its aggregate revision; a SKU without an image gets the one the file named for it. "
    + "Images already on the product are left as they are, so re-sending is safe. Images left `pending` ran out of the request's time budget: send them again. Failed images say why and never fail the product.",
  request: { body: { required: true, content: { "application/json": { schema: productImageBatchSchema } } } },
  responses: {
    200: { description: "What happened to each image", content: { "application/json": { schema: successEnvelope(z.object({ results: z.array(imageResultSchema), stoppedEarly: z.boolean() })) } } },
    ...errorResponses,
  },
});

importApp.openapi(productImagesRoute, async (c) => {
  assertBodySize(c);
  const batch = c.req.valid("json");
  const db = c.get("db");
  const response = await importProductImages(db, batch, {
    importMedia: async ({ sourceUrl, mediaId, filename }) => {
      const file = await importMediaFromUrl({ db, bucket: c.env.BUCKET, sourceUrl, mediaId, ...(filename ? { filename } : {}) });
      // Renditions stay pending; an open dashboard tab renders them in the background.
      return { id: file.id, kind: file.kind };
    },
  });
  return ok(c, response);
});

const customersRoute = createRoute({
  operationId: "dashboard.import.customers_batch",
  method: "post",
  path: "/customers",
  tags: ["Admin - Import and export"],
  summary: "Import a batch of customers",
  description: "Creates (mode `create`) or creates and fills in (mode `upsert`) up to 100 customers matched by phone, then email. Phones are E.164 and checked against the store's phone policy. "
    + "An existing customer only gains what it is missing (name, email, address, tags); nothing is overwritten or removed. Marketing consent is recorded only for channels marked true, with source `import` and `consentEvidence` as its note; false never unsubscribes. Re-sending is safe.",
  request: { body: { required: true, content: { "application/json": { schema: customerImportBatchSchema } } } },
  responses: {
    200: { description: "What happened to each customer", content: { "application/json": { schema: successEnvelope(z.object({ results: z.array(customerResultSchema), ...batchProgress })) } } },
    ...errorResponses,
  },
});

importApp.openapi(customersRoute, async (c) => {
  assertBodySize(c);
  const batch = c.req.valid("json");
  requireImportPermissions(c, CUSTOMER_MODE_PERMISSIONS[batch.mode]);
  return ok(c, await importCustomers(c.get("db"), batch, { actorId: staffId(c), env: c.env, send: notificationSender(c) }));
});

const inventoryRoute = createRoute({
  operationId: "dashboard.import.inventory_batch",
  method: "post",
  path: "/inventory",
  tags: ["Admin - Import and export"],
  summary: "Import on-hand counts by SKU and location",
  description: "Sets the units on hand of up to 100 SKUs at a location (its code or name; the default location when null) as ledger-v2 stocktakes with reason \"import\". A count that already matches writes nothing. "
    + "`runId` names the import run: each row's operation key derives from it, so a retried request replays instead of counting twice. A dry run reports current counts; send them as `expectedOnHand` and a row whose count changed since is refused.",
  request: { body: { required: true, content: { "application/json": { schema: inventoryImportBatchSchema } } } },
  responses: {
    200: { description: "What happened to each count", content: { "application/json": { schema: successEnvelope(z.object({ results: z.array(inventoryResultSchema), ...batchProgress })) } } },
    ...errorResponses,
  },
});

importApp.openapi(inventoryRoute, async (c) => {
  assertBodySize(c);
  const batch = c.req.valid("json");
  return ok(c, await importInventory(c.get("db"), batch, { actorId: staffId(c) }));
});

// ── Exports ────────────────────────────────────────────────────────────────

const exportApp = new OpenAPIHono<{ Bindings: Env }>();

const csvHeaders = (filename: string, page: { rowCount: number; itemCount: number; nextCursor: string | null }) => ({
  "Content-Type": "text/csv; charset=utf-8",
  "Content-Disposition": `attachment; filename="${filename}"`,
  "Cache-Control": "private, no-store",
  "X-Export-Row-Count": String(page.rowCount),
  "X-Export-Item-Count": String(page.itemCount),
  ...(page.nextCursor ? { "X-Export-Next-Cursor": page.nextCursor } : {}),
});

const pageQuery = (max: number) => ({
  after: z.string().trim().min(1).max(100).optional().openapi({ description: "The X-Export-Next-Cursor of the previous page." }),
  limit: z.coerce.number().int().min(1).max(max).optional(),
  header: z.enum(["true", "false"]).optional().openapi({ description: "false leaves out the header row (for pages after the first)." }),
});

const exportProductsRoute = createRoute({
  operationId: "dashboard.export.products",
  method: "get",
  path: "/products",
  tags: ["Admin - Import and export"],
  summary: "Export products as a Shopify product CSV",
  description: `One page (at most ${PRODUCT_EXPORT_PAGE_MAX} products) of the catalogue in Shopify's product CSV columns, importable by Shopify and by Scalius. X-Export-Next-Cursor names the next page; join the pages for the whole file.`,
  request: { query: z.object(pageQuery(PRODUCT_EXPORT_PAGE_MAX)) },
  responses: {
    200: { description: "CSV page", content: { "text/csv": { schema: z.string() } } },
    ...errorResponses,
  },
});

exportApp.openapi(exportProductsRoute, async (c) => {
  const query = c.req.valid("query");
  const page = await buildProductCsvPage(c.get("db"), {
    after: query.after ?? null,
    limit: query.limit,
    includeHeader: query.header !== "false",
    includeCosts: permissionsOf(c).has(PERMISSIONS.PRODUCTS_VIEW_COSTS),
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(page.body, { status: 200, headers: csvHeaders(`products-${day}.csv`, page) }) as never;
});

const exportInventoryRoute = createRoute({
  operationId: "dashboard.export.inventory",
  method: "get",
  path: "/inventory",
  tags: ["Admin - Import and export"],
  summary: "Export on-hand inventory per location as CSV",
  description: `One page (at most ${INVENTORY_EXPORT_PAGE_MAX} SKUs) of tracked SKUs with their units on hand at each active location (or one location), in the columns the inventory import reads back. X-Export-Next-Cursor names the next page.`,
  request: {
    query: z.object({
      ...pageQuery(INVENTORY_EXPORT_PAGE_MAX),
      locationId: z.string().trim().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: { description: "CSV page", content: { "text/csv": { schema: z.string() } } },
    ...errorResponses,
  },
});

exportApp.openapi(exportInventoryRoute, async (c) => {
  const query = c.req.valid("query");
  const page = await buildInventoryCsvPage(c.get("db"), {
    after: query.after ?? null,
    limit: query.limit,
    includeHeader: query.header !== "false",
    locationId: query.locationId ?? null,
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(page.body, { status: 200, headers: csvHeaders(`inventory-${day}.csv`, page) }) as never;
});

export { importApp as adminImportRoutes, exportApp as adminExportRoutes };
