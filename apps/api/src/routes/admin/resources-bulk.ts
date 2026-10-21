// The stable app API's bulk runs (operation-registry README, "Bulk runs"),
// mounted beside the resources at /admin/resources: variant prices, variant
// stock, customer tags, product status and product publishing for up to 5,000
// items. `dryRun: true` previews every item and writes nothing. A run of at
// most 250 items finishes in its request (200); a larger one answers 202 with
// the run and finishes right after the response and on the minute cron. One
// run per Idempotency-Key; `bulk_runs.get` reads its progress.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { nullableIsoTimestampSchema } from "../../schemas/timestamps";
import type { Context, MiddlewareHandler } from "hono";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { bulkRuns, BULK_RUN_KINDS, type BulkRunKind } from "@scalius/database/schema";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { planLimits } from "@scalius/shared/plan-limits";
import { NotFoundError, ValidationError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, namedSharedSchema, successEnvelope } from "../../schemas/responses";
import { idempotencyKeyHeaderSchema, scopedRequestKey } from "./idempotency";
import { afterResponse, executionContextOf } from "../../background/after-response";
import {
  BULK_CHUNK_ITEMS,
  BULK_SYNC_MAX_ITEMS,
  bulkPublishProductsSchema,
  bulkSetPricesSchema,
  bulkSetProductStatusSchema,
  bulkSetStockSchema,
  bulkTagCustomersSchema,
  type BulkRunInput,
} from "../../bulk-runs/inputs";
import {
  advanceBulkRun,
  createBulkRun,
  drainBulkRuns,
  isStaffBulkRun,
  presentBulkRun,
  previewBulkRun,
  readBulkRun,
  staffBulkRunCondition,
  type BulkRunRow,
} from "../../bulk-runs/engine";

const app = new OpenAPIHono<{ Bindings: Env }>();

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};
app.use("*", noStore);

const sampleValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const BulkRunResource = namedSharedSchema(z.object({
  id: z.string().nullable().openapi({ description: "The run's id; null for a dry run (nothing was started)." }),
  kind: z.enum(BULK_RUN_KINDS),
  status: z.enum(["preview", "running", "done", "failed"]).openapi({
    description: "preview: a dry run (nothing written). running: still going (read bulk_runs.get). done or failed: final.",
  }),
  dryRun: z.boolean(),
  total: z.number().int().openapi({ description: "Items the selection held when the run started." }),
  processed: z.number().int(),
  changed: z.number().int(),
  unchanged: z.number().int().openapi({ description: "Items already as asked (no write)." }),
  failed: z.number().int().openapi({ description: "Items refused; the first 50 are in failures with a code." }),
  currency: z.string().nullable().openapi({ description: "The store currency of every *Minor amount in sample (price runs); null otherwise." }),
  sample: z.array(z.record(z.string(), sampleValue)).openapi({
    description: "Before and after of the first 50 changes: prices (variantId, sku, beforeMinor, afterMinor), stock (variantId, locationId, beforeOnHand, afterOnHand), tags (customerId), status and publishing (productId).",
  }),
  failures: z.array(z.object({
    id: z.string(),
    code: z.string().openapi({ description: "price_changed, price_not_positive, stock_changed, below_reserved, not_found, retired, digital_stock, not_physical, revision_changed or needs_price." }),
  })),
  errorCode: z.string().nullable().openapi({ description: "Why a failed run stopped." }),
  createdAt: nullableIsoTimestampSchema,
  finishedAt: nullableIsoTimestampSchema,
}), "BulkRun");

const runResponses = {
  200: { description: "The dry run's preview, or the finished run", content: { "application/json": { schema: successEnvelope(BulkRunResource) } } },
  202: { description: "The run started; read bulk_runs.get until it is done", content: { "application/json": { schema: successEnvelope(BulkRunResource) } } },
  400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404],
  409: conflictResponse, 422: errorResponses[400], 429: errorResponses[429], 500: errorResponses[500],
};

/** Starts (or previews) a run; small runs finish here, large ones after the response. */
async function startRun(c: Context<{ Bindings: Env }>, operationId: string, run: BulkRunInput, idempotencyKey: string | undefined, dryRun: boolean | undefined) {
  const db = c.get("db");
  if (dryRun) return ok(c, await previewBulkRun(db, run));
  const operationKey = await scopedRequestKey(c, operationId, idempotencyKey);
  const createdBy = (c.get("user") as { id?: string } | undefined)?.id ?? null;
  const { row, created } = await createBulkRun(db, run, { operationKey, createdBy, lease: true });
  const currency = run.kind === "variants.set_prices" ? (await readStoreCurrency(db)).code : null;
  let current: BulkRunRow | undefined = row;
  if (created && row.total <= BULK_SYNC_MAX_ITEMS) {
    // One more chunk than the items need closes the walk on an exact multiple.
    current = await advanceBulkRun(db, row.id, Math.ceil(row.total / BULK_CHUNK_ITEMS) + 1);
  } else if (created) {
    await db.update(bulkRuns).set({ leaseUntil: null }).where(eq(bulkRuns.id, row.id));
    // The drain may reach app jobs too, so it carries the Worker runtime they run with.
    await afterResponse(c, "bulk run", () => drainBulkRuns(db, planLimits().background.bulkRunChunksPerDrain, { env: c.env, ctx: executionContextOf(c) }));
    current = await readBulkRun(db, row.id);
  }
  const latest = current && isStaffBulkRun(current) ? current : row;
  if (!isStaffBulkRun(latest)) throw new NotFoundError("Bulk run not found");
  const view = presentBulkRun(latest, currency);
  return c.json({ success: true as const, data: view }, view.status === "running" ? 202 : 200);
}

app.openapi(createRoute({
  operationId: "dashboard.resources.variants.bulk_set_prices",
  method: "post",
  path: "/variants/bulk-set-prices",
  tags: ["Admin - Resources"],
  summary: "Change many SKU prices at once",
  description: "Sets, raises or lowers the price of up to 5,000 SKUs, by id or by a product list filter, in integer minor units of the store currency (percent and amount changes round half up to the store's price increment). A SKU whose price would not stay above 0, or whose price changed since `expectedPriceMinor`, is left alone and listed in failures. Product revisions do not change. dryRun previews every SKU.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: bulkSetPricesSchema } } },
  },
  responses: runResponses,
}), async (c) => {
  const input = c.req.valid("json");
  const { dryRun, ...rest } = input;
  if (rest.change.mode === "set") {
    const currency = await readStoreCurrency(c.get("db"));
    if (rest.change.amountMinor % currency.priceIncrementMinor !== 0) {
      throw new ValidationError(`Prices go in steps of ${currency.priceIncrementMinor} minor units.`, { field: "change.amountMinor" });
    }
  }
  return startRun(c, "dashboard.resources.variants.bulk_set_prices", { kind: "variants.set_prices", input: rest }, c.req.valid("header")["idempotency-key"], dryRun) as never;
});

app.openapi(createRoute({
  operationId: "dashboard.resources.variants.bulk_set_stock",
  method: "post",
  path: "/variants/bulk-set-stock",
  tags: ["Admin - Resources"],
  summary: "Set many SKUs' on-hand quantities at a location",
  description: "Sets the counted units on hand of up to 5,000 SKUs at one location (the default when omitted). Each changed SKU gets one stock movement in the same write as its stockVersion. A SKU that is retired, digital, below its reserved units after the count, or changed since `expectedStockVersion` is left alone and listed in failures. dryRun previews every SKU.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: bulkSetStockSchema } } },
  },
  responses: runResponses,
}), async (c) => {
  const { dryRun, ...input } = c.req.valid("json");
  return startRun(c, "dashboard.resources.variants.bulk_set_stock", { kind: "variants.set_stock", input }, c.req.valid("header")["idempotency-key"], dryRun) as never;
});

app.openapi(createRoute({
  operationId: "dashboard.resources.customers.bulk_tag",
  method: "post",
  path: "/customers/bulk-tag",
  tags: ["Admin - Resources"],
  summary: "Add or remove tags on many customers",
  description: "Adds or removes up to 10 tags on up to 5,000 live customers, by id or by a filter (a tag they carry, an order-count range: 'more than 3 orders' is minOrders 4). A customer already at 50 tags keeps the tags it has. dryRun previews the customers.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: bulkTagCustomersSchema } } },
  },
  responses: runResponses,
}), async (c) => {
  const { dryRun, ...input } = c.req.valid("json");
  return startRun(c, "dashboard.resources.customers.bulk_tag", { kind: "customers.tag", input }, c.req.valid("header")["idempotency-key"], dryRun) as never;
});

app.openapi(createRoute({
  operationId: "dashboard.resources.products.bulk_set_status",
  method: "post",
  path: "/products/bulk-set-status",
  tags: ["Admin - Resources"],
  summary: "Activate or draft many products",
  description: "Sets up to 5,000 products active (sold) or draft (hidden), by id or by a product list filter. Activating skips a product without a price above 0 (failure needs_price); a product changed since `expectedAggregateRevision` is left alone. dryRun previews every product.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: bulkSetProductStatusSchema } } },
  },
  responses: runResponses,
}), async (c) => {
  const { dryRun, ...input } = c.req.valid("json");
  return startRun(c, "dashboard.resources.products.bulk_set_status", { kind: "products.set_status", input }, c.req.valid("header")["idempotency-key"], dryRun) as never;
});

app.openapi(createRoute({
  operationId: "dashboard.resources.products.bulk_publish",
  method: "post",
  path: "/products/bulk-publish",
  tags: ["Admin - Resources"],
  summary: "Publish or unpublish many products on sales channels",
  description: "Publishes or unpublishes up to 5,000 products, by id or by a product list filter, on up to 10 sales channels (online store, Google, Meta, AI agents, app channels). A product already in that state is left alone. dryRun previews the products.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: bulkPublishProductsSchema } } },
  },
  responses: runResponses,
}), async (c) => {
  const { dryRun, ...input } = c.req.valid("json");
  return startRun(c, "dashboard.resources.products.bulk_publish", { kind: "products.publish", input }, c.req.valid("header")["idempotency-key"], dryRun) as never;
});

const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404], 429: errorResponses[429], 500: errorResponses[500] };

async function viewOf(c: Context<{ Bindings: Env }>, row: BulkRunRow & { kind: BulkRunKind }) {
  const currency = row.kind === "variants.set_prices" ? (await readStoreCurrency(c.get("db"))).code : null;
  return presentBulkRun(row, currency);
}

app.openapi(createRoute({
  operationId: "dashboard.resources.bulk_runs.get",
  method: "get",
  path: "/bulk-runs/{id}",
  tags: ["Admin - Resources"],
  summary: "Get a bulk run's progress",
  description: "The run's status and counts, the before/after of its first 50 changes and its first 50 refusals. A running run continues on its own; read again until it is done or failed.",
  request: { params: z.object({ id: z.string().min(1).max(64) }) },
  responses: {
    200: { description: "The run", content: { "application/json": { schema: successEnvelope(BulkRunResource) } } },
    ...readResponses,
  },
}), async (c) => {
  const row = await readBulkRun(c.get("db"), c.req.valid("param").id);
  // An app's background job is the app's, never a staff bulk run.
  if (!row || !isStaffBulkRun(row)) throw new NotFoundError("Bulk run not found");
  return ok(c, await viewOf(c, row));
});

const LIST_PAGE = 20;

app.openapi(createRoute({
  operationId: "dashboard.resources.bulk_runs.list",
  method: "get",
  path: "/bulk-runs",
  tags: ["Admin - Resources"],
  summary: "List bulk runs, newest first",
  request: {
    query: z.object({
      status: z.enum(["running", "done", "failed"]).optional(),
      cursor: z.string().regex(/^bulk_[a-f0-9]{32}$/u).optional().openapi({ description: "The `nextCursor` of the page before." }),
      limit: z.coerce.number().int().min(1).max(LIST_PAGE).default(LIST_PAGE),
    }),
  },
  responses: {
    200: {
      description: "One page of runs",
      content: { "application/json": { schema: successEnvelope(z.object({
        runs: z.array(BulkRunResource),
        nextCursor: z.string().nullable().openapi({ description: "Pass it as `cursor` for the next page; null on the last page." }),
      })) } },
    },
    ...readResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const { status, cursor, limit } = c.req.valid("query");
  const anchor = cursor ? await readBulkRun(db, cursor) : undefined;
  if (cursor && (!anchor || !isStaffBulkRun(anchor))) throw new ValidationError("This page cursor is not valid.", { field: "cursor" });
  const rows = (await db.select().from(bulkRuns)
    .where(and(
      staffBulkRunCondition(),
      status ? eq(bulkRuns.status, status) : undefined,
      anchor ? or(lt(bulkRuns.createdAt, anchor.createdAt), and(eq(bulkRuns.createdAt, anchor.createdAt), lt(bulkRuns.id, anchor.id))) : undefined,
    ))
    .orderBy(desc(bulkRuns.createdAt), desc(bulkRuns.id))
    .limit(limit + 1)).filter(isStaffBulkRun);
  const page = rows.slice(0, limit);
  const currency = page.some((row) => row.kind === "variants.set_prices") ? (await readStoreCurrency(db)).code : null;
  return ok(c, {
    runs: page.map((row) => presentBulkRun(row, row.kind === "variants.set_prices" ? currency : null)),
    nextCursor: rows.length > limit ? page.at(-1)!.id : null,
  });
});

export { app as adminResourceBulkRoutes };
