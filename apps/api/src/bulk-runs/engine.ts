// Bulk runs (packages/database/src/schema/bulk-runs.ts): the five reviewed
// bulk changes behind /api/v1/admin/resources/*/bulk-*.
//
// A run walks its selection in id order, BULK_CHUNK_ITEMS at a time. Every
// chunk commits its writes and the run's progress in one batch, guarded on
// the chunk counter it read, so a repeat or a second drain never applies a
// chunk twice and a crash between chunks loses nothing:
//
//   - prices: the SKU price updates (compare-and-set on the price read), the
//     products' derived price, the buyer-state refresh and the run advance
//     in one batch. Field-level: no product aggregateRevision churn. SQL
//     triggers advance the cache dependencies of every row it writes.
//   - stock: one multi-SKU stock command (ledger-v2 `adjusted` movements and
//     the stockVersion CAS of each SKU, inventory/stock-commands.ts) whose
//     subject is the run: the run advance is the command's document write.
//   - tags, status, publishing: the domain's own idempotent bulk write, then
//     the run advance; a chunk repeated after a crash changes nothing more.
//
// A dry run reads the same selection and plans every item without a write.
import { and, asc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { buildBatchGuard, isBatchGuardError, safeBatch, withCoarseCacheClock, type Database } from "@scalius/database/client";
import { bulkRuns, customerTagLinks, customers, inventoryLevels, productVariants, products, type BulkRunKind } from "@scalius/database/schema";
import { roundToIncrementMinor } from "@scalius/shared/money";
import { dueBulkRunCondition } from "./due";
import { AppError, ConflictError, ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { catalogBuyerStateRefreshStatementsForSkus, isDigitalKind } from "@scalius/core/modules/products";
import { bulkUpdateProducts, productListConditions, productListLeads } from "@scalius/core/modules/product-admin";
import { addTagsToCustomers, removeTagsFromCustomers } from "@scalius/core/modules/customers";
import { setProductPublications } from "@scalius/core/modules/sales-channels";
import {
  executeStockCommand,
  resolveActiveInventoryLocation,
  StockCommandSubjectMovedError,
  type InventoryLocationRef,
  type StockCommandLine,
} from "@scalius/core/modules/inventory";
import {
  BULK_CHUNK_ITEMS,
  BULK_RUN_MAX_ITEMS,
  BULK_SAMPLE_MAX,
  type BulkProductFilter,
  type BulkPublishProductsInput,
  type BulkRunInput,
  type BulkSetPricesInput,
  type BulkSetProductStatusInput,
  type BulkSetStockInput,
  type BulkTagCustomersInput,
} from "./inputs";

export type BulkSampleValue = string | number | boolean | null;
export type BulkSample = Record<string, BulkSampleValue>;
export type BulkFailure = { id: string; code: string };

/** One chunk's plan: what it changes, refuses and leaves alone. */
type ChunkPlan = {
  /** Ids the walk covered (the next cursor is the last). */
  ids: string[];
  sample: BulkSample[];
  failures: BulkFailure[];
  changed: number;
  unchanged: number;
};

export type BulkRunRow = typeof bulkRuns.$inferSelect;

export type BulkRunView = {
  id: string | null;
  kind: BulkRunKind;
  status: "preview" | "running" | "done" | "failed";
  dryRun: boolean;
  total: number;
  processed: number;
  changed: number;
  unchanged: number;
  failed: number;
  currency: string | null;
  sample: BulkSample[];
  failures: BulkFailure[];
  errorCode: string | null;
  createdAt: string | null;
  finishedAt: string | null;
};

const RUN_MOVED = "BULK_RUN_MOVED";
const PRICE_CAS = "BULK_PRICE_CAS";
const LEASE_SECONDS = 120;
/** A dry run reads its selection this many rows per query. */
const PREVIEW_PAGE = 500;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const json = (value: unknown) => JSON.stringify(value);
const inJson = (column: SQL | typeof productVariants.id, ids: readonly string[]) =>
  sql`${column} IN (SELECT value FROM json_each(${json(ids)}))`;

// ─── Selections ─────────────────────────────────────────────────────────────

async function productConditions(db: Database, filter: BulkProductFilter): Promise<SQL[]> {
  return productListConditions(db, {
    search: filter.search,
    categoryId: filter.category,
    status: filter.status,
    salesChannelId: filter.salesChannel,
    leadWithMatches: await productListLeads(db, { search: filter.search }),
  }).conditions;
}

type PriceRow = { id: string; productId: string; sku: string; priceMinor: number };

async function priceWhere(db: Database, input: BulkSetPricesInput, cursor: string | null): Promise<SQL | undefined> {
  return and(
    isNull(productVariants.deletedAt),
    isNull(products.deletedAt),
    cursor ? gt(productVariants.id, cursor) : undefined,
    input.variants ? inJson(productVariants.id, input.variants.map((variant) => variant.id)) : undefined,
    ...(input.filter ? await productConditions(db, input.filter) : []),
  );
}

async function pricePage(db: Database, input: BulkSetPricesInput, cursor: string | null, limit: number): Promise<PriceRow[]> {
  return db.select({
    id: productVariants.id,
    productId: productVariants.productId,
    sku: productVariants.sku,
    priceMinor: productVariants.priceMinor,
  })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(await priceWhere(db, input, cursor))
    .orderBy(asc(productVariants.id))
    .limit(limit);
}

type StockRow = {
  id: string;
  sku: string | null;
  quantity: number;
  expectedStockVersion: number | undefined;
  stock: number;
  reservedStock: number;
  preorderStock: number;
  stockVersion: number;
  fulfillmentKind: string | null;
  deletedAt: Date | null;
  exists: boolean;
  onHand: number;
};

function stockItemsAfter(input: BulkSetStockInput, cursor: string | null, limit: number) {
  return [...input.items]
    .sort((left, right) => (left.variantId < right.variantId ? -1 : left.variantId > right.variantId ? 1 : 0))
    .filter((item) => cursor === null || item.variantId > cursor)
    .slice(0, limit);
}

async function stockPage(
  db: Database,
  input: BulkSetStockInput,
  location: InventoryLocationRef,
  cursor: string | null,
  limit: number,
): Promise<StockRow[]> {
  const items = stockItemsAfter(input, cursor, limit);
  if (items.length === 0) return [];
  const ids = items.map((item) => item.variantId);
  // One JSON parameter per read, whatever the page size (D1's 100 bound values).
  const [skus, levels] = await Promise.all([
    db.select({
      id: productVariants.id,
      sku: productVariants.sku,
      stock: productVariants.stock,
      reservedStock: productVariants.reservedStock,
      preorderStock: productVariants.preorderStock,
      stockVersion: productVariants.stockVersion,
      fulfillmentKind: productVariants.fulfillmentKind,
      deletedAt: productVariants.deletedAt,
    }).from(productVariants).where(inJson(productVariants.id, ids)),
    db.select({ variantId: inventoryLevels.variantId, onHand: inventoryLevels.onHand })
      .from(inventoryLevels)
      .where(and(eq(inventoryLevels.locationId, location.id), inJson(sql`${inventoryLevels.variantId}`, ids))),
  ]);
  const byId = new Map(skus.map((row) => [row.id, row]));
  const onHand = new Map(levels.map((row) => [row.variantId, row.onHand]));
  return items.map((item) => {
    const sku = byId.get(item.variantId);
    return {
      id: item.variantId,
      sku: sku?.sku ?? null,
      quantity: item.quantity,
      expectedStockVersion: item.expectedStockVersion,
      stock: sku?.stock ?? 0,
      reservedStock: sku?.reservedStock ?? 0,
      preorderStock: sku?.preorderStock ?? 0,
      stockVersion: sku?.stockVersion ?? 0,
      fulfillmentKind: sku?.fulfillmentKind ?? null,
      deletedAt: sku?.deletedAt ?? null,
      exists: sku !== undefined,
      onHand: onHand.get(item.variantId) ?? 0,
    };
  });
}

type CustomerRow = { id: string; totalOrders: number };

function customerWhere(input: BulkTagCustomersInput, cursor: string | null): SQL | undefined {
  const filter = input.filter;
  return and(
    isNull(customers.deletedAt),
    cursor ? gt(customers.id, cursor) : undefined,
    input.customerIds ? inJson(sql`${customers.id}`, input.customerIds) : undefined,
    filter?.minOrders !== undefined ? sql`${customers.totalOrders} >= ${filter.minOrders}` : undefined,
    filter?.maxOrders !== undefined ? sql`${customers.totalOrders} <= ${filter.maxOrders}` : undefined,
    filter?.tag !== undefined
      ? sql`EXISTS (SELECT 1 FROM ${customerTagLinks} WHERE ${customerTagLinks.customerId} = ${customers.id} AND ${customerTagLinks.tag} = ${filter.tag.toLowerCase()})`
      : undefined,
  );
}

async function customerPage(db: Database, input: BulkTagCustomersInput, cursor: string | null, limit: number): Promise<CustomerRow[]> {
  return db.select({ id: customers.id, totalOrders: customers.totalOrders })
    .from(customers)
    .where(customerWhere(input, cursor))
    .orderBy(asc(customers.id))
    .limit(limit);
}

type ProductRow = { id: string; aggregateRevision: number; isActive: boolean };

async function productWhere(
  db: Database,
  input: BulkSetProductStatusInput | BulkPublishProductsInput,
  cursor: string | null,
): Promise<SQL | undefined> {
  const ids = "products" in input && input.products
    ? input.products.map((product) => product.id)
    : "productIds" in input ? input.productIds : undefined;
  return and(
    isNull(products.deletedAt),
    cursor ? gt(products.id, cursor) : undefined,
    ids ? inJson(sql`${products.id}`, ids) : undefined,
    ...(input.filter ? await productConditions(db, input.filter) : []),
  );
}

async function productPage(
  db: Database,
  input: BulkSetProductStatusInput | BulkPublishProductsInput,
  cursor: string | null,
  limit: number,
): Promise<ProductRow[]> {
  return db.select({ id: products.id, aggregateRevision: products.aggregateRevision, isActive: products.isActive })
    .from(products)
    .where(await productWhere(db, input, cursor))
    .orderBy(asc(products.id))
    .limit(limit);
}

/** How many items the run's selection holds now. */
async function countSelection(db: Database, run: BulkRunInput): Promise<number> {
  const count = sql<number>`count(*)`;
  switch (run.kind) {
    case "variants.set_prices": {
      const [row] = await db.select({ count }).from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(await priceWhere(db, run.input, null));
      return Number(row?.count ?? 0);
    }
    case "variants.set_stock":
      return run.input.items.length;
    case "customers.tag": {
      const [row] = await db.select({ count }).from(customers).where(customerWhere(run.input, null));
      return Number(row?.count ?? 0);
    }
    case "products.set_status":
    case "products.publish": {
      const [row] = await db.select({ count }).from(products).where(await productWhere(db, run.input, null));
      return Number(row?.count ?? 0);
    }
  }
}

// ─── Planning (pure) ────────────────────────────────────────────────────────

type PricePlanItem = { row: PriceRow; afterMinor: number };

function newPriceMinor(before: number, change: BulkSetPricesInput["change"], increment: number): number {
  switch (change.mode) {
    case "set":
      return change.amountMinor;
    case "percent": {
      // Exact basis-point arithmetic, then half up to the increment.
      const bps = Math.round(change.percent * 100);
      const raw = Number((BigInt(before) * BigInt(10_000 + bps) * 2n + 10_000n) / 20_000n);
      return roundToIncrementMinor(raw, increment);
    }
    case "amount":
      return roundToIncrementMinor(before + change.amountMinor, increment);
  }
}

function planPrices(rows: readonly PriceRow[], input: BulkSetPricesInput, increment: number) {
  const expected = new Map((input.variants ?? []).map((variant) => [variant.id, variant.expectedPriceMinor]));
  const items: PricePlanItem[] = [];
  const plan: ChunkPlan = { ids: rows.map((row) => row.id), sample: [], failures: [], changed: 0, unchanged: 0 };
  for (const row of rows) {
    const wanted = expected.get(row.id);
    if (wanted !== undefined && wanted !== row.priceMinor) {
      plan.failures.push({ id: row.id, code: "price_changed" });
      continue;
    }
    const afterMinor = newPriceMinor(row.priceMinor, input.change, increment);
    if (!Number.isSafeInteger(afterMinor) || afterMinor <= 0) {
      plan.failures.push({ id: row.id, code: "price_not_positive" });
      continue;
    }
    if (afterMinor === row.priceMinor) {
      plan.unchanged += 1;
      continue;
    }
    items.push({ row, afterMinor });
    plan.changed += 1;
    plan.sample.push({ variantId: row.id, productId: row.productId, sku: row.sku, beforeMinor: row.priceMinor, afterMinor });
  }
  return { plan, items };
}

function planStock(rows: readonly StockRow[], location: InventoryLocationRef) {
  const plan: ChunkPlan = { ids: rows.map((row) => row.id), sample: [], failures: [], changed: 0, unchanged: 0 };
  const lines: Array<{ row: StockRow; delta: number }> = [];
  for (const row of rows) {
    const refusal = !row.exists ? "not_found"
      : row.deletedAt ? "retired"
        : row.fulfillmentKind && isDigitalKind(row.fulfillmentKind) ? "digital_stock"
          : row.fulfillmentKind !== "physical" ? "not_physical"
            : row.expectedStockVersion !== undefined && row.expectedStockVersion !== row.stockVersion ? "stock_changed"
              : null;
    if (refusal) {
      plan.failures.push({ id: row.id, code: refusal });
      continue;
    }
    const delta = row.quantity - row.onHand;
    if (delta === 0) {
      plan.unchanged += 1;
      continue;
    }
    if (row.stock + delta < row.reservedStock) {
      plan.failures.push({ id: row.id, code: "below_reserved" });
      continue;
    }
    lines.push({ row, delta });
    plan.changed += 1;
    plan.sample.push({ variantId: row.id, sku: row.sku, locationId: location.id, beforeOnHand: row.onHand, afterOnHand: row.quantity });
  }
  return { plan, lines };
}

function planCustomers(rows: readonly CustomerRow[]): ChunkPlan {
  return {
    ids: rows.map((row) => row.id),
    sample: rows.map((row) => ({ customerId: row.id, totalOrders: row.totalOrders })),
    failures: [],
    changed: rows.length,
    unchanged: 0,
  };
}

function planStatus(rows: readonly ProductRow[], input: BulkSetProductStatusInput) {
  const expected = new Map((input.products ?? []).map((product) => [product.id, product.expectedAggregateRevision]));
  const active = input.status === "active";
  const plan: ChunkPlan = { ids: rows.map((row) => row.id), sample: [], failures: [], changed: 0, unchanged: 0 };
  const claims: Array<{ id: string; expectedAggregateRevision: number }> = [];
  for (const row of rows) {
    const wanted = expected.get(row.id);
    if (wanted !== undefined && wanted !== row.aggregateRevision) {
      plan.failures.push({ id: row.id, code: "revision_changed" });
    } else if (row.isActive === active) {
      plan.unchanged += 1;
    } else {
      claims.push({ id: row.id, expectedAggregateRevision: row.aggregateRevision });
      plan.changed += 1;
      plan.sample.push({ productId: row.id, before: row.isActive ? "active" : "draft", after: input.status });
    }
  }
  return { plan, claims };
}

function planPublish(rows: readonly ProductRow[], input: BulkPublishProductsInput): ChunkPlan {
  return {
    ids: rows.map((row) => row.id),
    sample: rows.map((row) => ({ productId: row.id, action: input.action })),
    failures: [],
    changed: rows.length,
    unchanged: 0,
  };
}

// ─── Dry run ────────────────────────────────────────────────────────────────

function emptyView(kind: BulkRunKind, currency: string | null): BulkRunView {
  return {
    id: null, kind, status: "preview", dryRun: true, total: 0, processed: 0, changed: 0, unchanged: 0, failed: 0,
    currency, sample: [], failures: [], errorCode: null, createdAt: null, finishedAt: null,
  };
}

function absorb(view: BulkRunView, plan: ChunkPlan): void {
  view.processed += plan.ids.length;
  view.changed += plan.changed;
  view.unchanged += plan.unchanged;
  view.failed += plan.failures.length;
  view.sample.push(...plan.sample.slice(0, BULK_SAMPLE_MAX - view.sample.length));
  view.failures.push(...plan.failures.slice(0, BULK_SAMPLE_MAX - view.failures.length));
}

/** Plans every item of the selection (at most BULK_RUN_MAX_ITEMS) and writes nothing. */
export async function previewBulkRun(db: Database, run: BulkRunInput): Promise<BulkRunView> {
  const total = await countSelection(db, run);
  assertSelectionSize(total);
  const currency = run.kind === "variants.set_prices" ? await readStoreCurrency(db) : null;
  const view = emptyView(run.kind, currency?.code ?? null);
  view.total = total;
  const location = run.kind === "variants.set_stock" ? await resolveActiveInventoryLocation(db, run.input.locationId) : null;
  let cursor: string | null = null;
  for (let read = 0; read * PREVIEW_PAGE < BULK_RUN_MAX_ITEMS; read += 1) {
    let plan: ChunkPlan;
    switch (run.kind) {
      case "variants.set_prices":
        plan = planPrices(await pricePage(db, run.input, cursor, PREVIEW_PAGE), run.input, currency!.priceIncrementMinor).plan;
        break;
      case "variants.set_stock":
        plan = planStock(await stockPage(db, run.input, location!, cursor, PREVIEW_PAGE), location!).plan;
        break;
      case "customers.tag":
        plan = planCustomers(await customerPage(db, run.input, cursor, PREVIEW_PAGE));
        break;
      case "products.set_status":
        plan = planStatus(await productPage(db, run.input, cursor, PREVIEW_PAGE), run.input).plan;
        break;
      case "products.publish":
        plan = planPublish(await productPage(db, run.input, cursor, PREVIEW_PAGE), run.input);
        break;
    }
    absorb(view, plan);
    if (plan.ids.length < PREVIEW_PAGE) break;
    cursor = plan.ids.at(-1)!;
  }
  view.status = "preview";
  return view;
}

function assertSelectionSize(total: number): void {
  if (total > BULK_RUN_MAX_ITEMS) {
    throw new ValidationError(`This selection holds ${total} items; a bulk run changes at most ${BULK_RUN_MAX_ITEMS}. Narrow the filter.`, {
      code: "bulk_selection_too_large",
      total,
    });
  }
}

// ─── Runs ───────────────────────────────────────────────────────────────────

async function requestHash(run: BulkRunInput): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json({ kind: run.kind, input: run.input })));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readResults(row: BulkRunRow): { sample: BulkSample[]; failures: BulkFailure[] } {
  try {
    const parsed = JSON.parse(row.results) as { sample?: BulkSample[]; failures?: BulkFailure[] };
    return { sample: parsed.sample ?? [], failures: parsed.failures ?? [] };
  } catch {
    return { sample: [], failures: [] };
  }
}

export function presentBulkRun(row: BulkRunRow, currency: string | null): BulkRunView {
  const results = readResults(row);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    dryRun: false,
    total: row.total,
    processed: row.processed,
    changed: row.changed,
    unchanged: Math.max(0, row.processed - row.changed - row.failed),
    failed: row.failed,
    currency,
    sample: results.sample,
    failures: results.failures,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

export function bulkRunInput(row: BulkRunRow): BulkRunInput {
  return { kind: row.kind, input: JSON.parse(row.input) } as BulkRunInput;
}

/**
 * Starts a run, or returns the run an earlier request under the same key
 * started (a different request under it is refused). `lease` holds it for
 * the caller that drives it inline.
 */
export async function createBulkRun(
  db: Database,
  run: BulkRunInput,
  options: { operationKey: string; createdBy: string | null; lease: boolean },
): Promise<{ row: BulkRunRow; created: boolean }> {
  const hash = await requestHash(run);
  const existing = await db.select().from(bulkRuns).where(eq(bulkRuns.operationKey, options.operationKey)).get();
  if (existing) {
    if (existing.requestHash !== hash || existing.kind !== run.kind) {
      throw new AppError(422, "idempotency_key_reused", "This Idempotency-Key started a different bulk run.");
    }
    return { row: existing, created: false };
  }
  const total = await countSelection(db, run);
  assertSelectionSize(total);
  const id = `bulk_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const [row] = await db.insert(bulkRuns).values({
    id,
    kind: run.kind,
    operationKey: options.operationKey,
    requestHash: hash,
    input: json(run.input),
    total,
    createdBy: options.createdBy,
    leaseUntil: options.lease ? nowSeconds() + LEASE_SECONDS : null,
  }).onConflictDoNothing().returning();
  if (!row) {
    // A concurrent request under the same key won the insert.
    const raced = await db.select().from(bulkRuns).where(eq(bulkRuns.operationKey, options.operationKey)).get();
    if (!raced || raced.requestHash !== hash) throw new ConflictError("This bulk run is starting in another request. Read it again.");
    return { row: raced, created: false };
  }
  return { row, created: true };
}

/** The run's progress write: the chunk counter it read moves on by one. */
function runAdvance(db: Database, row: BulkRunRow, plan: ChunkPlan, done: boolean): BatchItem<"sqlite"> {
  const results = readResults(row);
  const sample = [...results.sample, ...plan.sample].slice(0, BULK_SAMPLE_MAX);
  const failures = [...results.failures, ...plan.failures].slice(0, BULK_SAMPLE_MAX);
  return db.update(bulkRuns).set({
    chunks: sql`${bulkRuns.chunks} + 1`,
    cursor: plan.ids.at(-1) ?? row.cursor,
    processed: sql`${bulkRuns.processed} + ${plan.ids.length}`,
    changed: sql`${bulkRuns.changed} + ${plan.changed}`,
    failed: sql`${bulkRuns.failed} + ${plan.failures.length}`,
    results: json({ sample, failures }),
    ...(done ? { status: "done" as const, finishedAt: sql`unixepoch()`, leaseUntil: null } : {}),
    updatedAt: sql`unixepoch()`,
  }).where(and(eq(bulkRuns.id, row.id), eq(bulkRuns.chunks, row.chunks), eq(bulkRuns.status, "running"))) as unknown as BatchItem<"sqlite">;
}

/** True while the run is still at the chunk this plan was read from. */
function runAtChunkSql(row: BulkRunRow): SQL {
  return sql`EXISTS (SELECT 1 FROM ${bulkRuns} WHERE ${bulkRuns.id} = ${row.id} AND ${bulkRuns.chunks} = ${row.chunks} AND ${bulkRuns.status} = 'running')`;
}

async function commitAdvance(db: Database, row: BulkRunRow, plan: ChunkPlan, done: boolean, writes: BatchItem<"sqlite">[] = []): Promise<void> {
  await safeBatch(db, [buildBatchGuard(db, runAtChunkSql(row), RUN_MOVED), ...writes, runAdvance(db, row, plan, done)] as never);
}

/** The products' own price follows their SKUs: the lowest optioned SKU, else the simple product's hidden SKU. */
function productPriceRefresh(db: Database, productIds: readonly string[]): BatchItem<"sqlite"> {
  return db.update(products).set({
    priceMinor: sql`COALESCE(
      (SELECT MIN(sku.price_minor) FROM ${productVariants} AS sku
        WHERE sku.product_id = ${products.id} AND sku.deleted_at IS NULL AND sku.is_default = 0
          AND trim(coalesce(sku.option_combination_key, '')) <> ''),
      (SELECT sku.price_minor FROM ${productVariants} AS sku
        WHERE sku.product_id = ${products.id} AND sku.deleted_at IS NULL AND sku.is_default = 1 LIMIT 1),
      ${products.priceMinor})`,
  }).where(inJson(sql`${products.id}`, productIds)) as unknown as BatchItem<"sqlite">;
}

async function runPriceChunk(db: Database, row: BulkRunRow, input: BulkSetPricesInput): Promise<boolean> {
  const currency = await readStoreCurrency(db);
  const rows = await pricePage(db, input, row.cursor, BULK_CHUNK_ITEMS);
  const { plan, items } = planPrices(rows, input, currency.priceIncrementMinor);
  const done = rows.length < BULK_CHUNK_ITEMS;
  const writes: BatchItem<"sqlite">[] = items.map((item) => db.update(productVariants).set({
    priceMinor: item.afterMinor,
    version: sql`${productVariants.version} + 1`,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(productVariants.id, item.row.id),
    eq(productVariants.priceMinor, item.row.priceMinor),
    isNull(productVariants.deletedAt),
  )) as unknown as BatchItem<"sqlite">);
  if (items.length > 0) {
    const landed = json(items.map((item) => ({ id: item.row.id, p: item.afterMinor })));
    // A price changed since the read loses the compare-and-set: the chunk aborts and is read again.
    writes.push(buildBatchGuard(db, sql`NOT EXISTS (
      SELECT 1 FROM json_each(${landed}) AS planned
      JOIN ${productVariants} AS sku ON sku.id = json_extract(planned.value, '$.id')
      WHERE sku.price_minor <> json_extract(planned.value, '$.p') OR sku.deleted_at IS NOT NULL
    )`, PRICE_CAS));
    writes.push(productPriceRefresh(db, [...new Set(items.map((item) => item.row.productId))]));
    writes.push(...catalogBuyerStateRefreshStatementsForSkus(db, items.map((item) => item.row.id)) as BatchItem<"sqlite">[]);
  }
  await commitAdvance(db, row, plan, done, writes);
  return done;
}

async function runStockChunk(db: Database, row: BulkRunRow, input: BulkSetStockInput): Promise<boolean> {
  const location = await resolveActiveInventoryLocation(db, input.locationId);
  type Read = { planned: ReturnType<typeof planStock>; done: boolean };
  const read = async (): Promise<Read> => {
    const rows = await stockPage(db, input, location, row.cursor, BULK_CHUNK_ITEMS);
    return { planned: planStock(rows, location), done: rows.length < BULK_CHUNK_ITEMS };
  };
  const first = await read();
  if (first.planned.lines.length === 0) {
    await commitAdvance(db, row, first.planned.plan, first.done);
    return first.done;
  }
  const reason = input.reason ?? "Bulk stock count";
  // The first attempt uses the plan read above; a lost SKU race re-reads.
  let reuse: Read | null = first;
  let committed: Read = first;
  await executeStockCommand(db, {
    operationKey: `bulk-${row.id}-chunk-${row.chunks + 1}`,
    replay: "subject",
    commandType: "bulk_set_quantities",
    subjectId: row.id,
    request: { locationId: location.id, items: first.planned.lines.map((line) => [line.row.id, line.row.quantity]) },
    createdBy: row.createdBy,
    plan: async () => {
      const current = reuse ?? await read();
      reuse = null;
      committed = current;
      // Nothing left to move after a race: the run's own retry commits the advance alone.
      if (current.planned.lines.length === 0) throw new ConflictError("Stock changed while this chunk was planned.");
      const lines: StockCommandLine[] = current.planned.lines.map((line) => ({
        variantId: line.row.id,
        location,
        type: "adjusted",
        quantity: line.delta,
        notes: `${reason}: ${location.name} counted ${line.row.quantity}`,
      }));
      return {
        lines,
        subjectGuard: runAtChunkSql(row),
        subjectRevisionAfter: row.chunks + 1,
        documentStatements: () => [runAdvance(db, row, current.planned.plan, current.done)],
        result: () => null,
      };
    },
  });
  return committed.done;
}

async function runCustomerChunk(db: Database, row: BulkRunRow, input: BulkTagCustomersInput): Promise<boolean> {
  const rows = await customerPage(db, input, row.cursor, BULK_CHUNK_ITEMS);
  const plan = planCustomers(rows);
  const ids = rows.map((customer) => customer.id);
  if (ids.length > 0 && input.add) await addTagsToCustomers(db, { customerIds: ids, tags: input.add });
  if (ids.length > 0 && input.remove) await removeTagsFromCustomers(db, { customerIds: ids, tags: input.remove });
  const done = rows.length < BULK_CHUNK_ITEMS;
  await commitAdvance(db, row, plan, done);
  return done;
}

async function runStatusChunk(db: Database, row: BulkRunRow, input: BulkSetProductStatusInput): Promise<boolean> {
  const rows = await productPage(db, input, row.cursor, BULK_CHUNK_ITEMS);
  const { plan, claims } = planStatus(rows, input);
  if (claims.length > 0) {
    const result = await bulkUpdateProducts(db, claims, { isActive: input.status === "active" });
    for (const skipped of result.skipped) {
      plan.changed -= 1;
      plan.sample = plan.sample.filter((entry) => entry.productId !== skipped.id);
      plan.failures.push({ id: skipped.id, code: skipped.reason });
    }
  }
  const done = rows.length < BULK_CHUNK_ITEMS;
  await commitAdvance(db, row, plan, done);
  return done;
}

async function runPublishChunk(db: Database, row: BulkRunRow, input: BulkPublishProductsInput): Promise<boolean> {
  const rows = await productPage(db, input, row.cursor, BULK_CHUNK_ITEMS);
  const plan = planPublish(rows, input);
  if (rows.length > 0) {
    await setProductPublications(db, { productIds: rows.map((product) => product.id), channelIds: input.channelIds, action: input.action });
  }
  const done = rows.length < BULK_CHUNK_ITEMS;
  await commitAdvance(db, row, plan, done);
  return done;
}

async function runChunk(db: Database, row: BulkRunRow): Promise<boolean> {
  const run = bulkRunInput(row);
  switch (run.kind) {
    case "variants.set_prices": return runPriceChunk(db, row, run.input);
    case "variants.set_stock": return runStockChunk(db, row, run.input);
    case "customers.tag": return runCustomerChunk(db, row, run.input);
    case "products.set_status": return runStatusChunk(db, row, run.input);
    case "products.publish": return runPublishChunk(db, row, run.input);
  }
}

/** A lost race: another writer moved the run, a price or a SKU on since the read. */
function isRetryable(error: unknown): boolean {
  return error instanceof StockCommandSubjectMovedError ||
    isBatchGuardError(error, RUN_MOVED) ||
    isBatchGuardError(error, PRICE_CAS) ||
    error instanceof ConflictError ||
    error instanceof ServiceUnavailableError;
}

async function readRun(db: Database, id: string): Promise<BulkRunRow | undefined> {
  return db.select().from(bulkRuns).where(eq(bulkRuns.id, id)).get();
}

/**
 * Commits up to `maxChunks` chunks of one run. A lost race re-reads the run
 * and tries the chunk again (a few times); any other error stops the run as
 * failed with its code. Returns the run as it stands.
 */
export async function advanceBulkRun(db: Database, id: string, maxChunks: number): Promise<BulkRunRow | undefined> {
  let row = await readRun(db, id);
  let races = 0;
  for (let chunk = 0; row && row.status === "running" && chunk < maxChunks;) {
    try {
      // Coarse cache clock (as the projection rebuild): a chunk of 90 items
      // advances `store` a few times instead of every row's keys, so a
      // 5,000-item run fits Free's daily writes.
      const current = row;
      await withCoarseCacheClock(() => runChunk(db, current));
      chunk += 1;
      races = 0;
    } catch (error) {
      if (!isRetryable(error) || races >= 3) {
        const code = error instanceof AppError ? error.code : "chunk_failed";
        console.warn("[bulk-runs] run stopped", { kind: row.kind, code });
        await db.update(bulkRuns).set({
          status: "failed",
          errorCode: code.slice(0, 64),
          finishedAt: sql`unixepoch()`,
          leaseUntil: null,
          updatedAt: sql`unixepoch()`,
        }).where(and(eq(bulkRuns.id, row.id), eq(bulkRuns.status, "running")));
        return readRun(db, id);
      }
      races += 1;
    }
    row = await readRun(db, id);
  }
  if (row?.status === "running") {
    await db.update(bulkRuns).set({ leaseUntil: null }).where(eq(bulkRuns.id, row.id));
  }
  return row;
}

/** Claims the oldest due run nobody holds. */
async function claimDueRun(db: Database): Promise<string | null> {
  const now = nowSeconds();
  const due = await db.select({ id: bulkRuns.id }).from(bulkRuns)
    .where(dueBulkRunCondition(now))
    .orderBy(asc(bulkRuns.createdAt), asc(bulkRuns.id))
    .limit(1)
    .get();
  if (!due) return null;
  const claimed = await db.update(bulkRuns).set({ leaseUntil: now + LEASE_SECONDS })
    .where(and(eq(bulkRuns.id, due.id), dueBulkRunCondition(now)))
    .returning({ id: bulkRuns.id });
  return claimed[0]?.id ?? null;
}

/**
 * The background drain (right after a large run's request, and every minute):
 * up to `maxChunks` chunks of due runs, oldest first.
 */
export async function drainBulkRuns(db: Database, maxChunks: number): Promise<number> {
  let budget = maxChunks;
  let runs = 0;
  while (budget > 0) {
    const id = await claimDueRun(db);
    if (!id) break;
    const before = await readRun(db, id);
    const after = await advanceBulkRun(db, id, budget);
    budget -= Math.max(1, (after?.chunks ?? 0) - (before?.chunks ?? 0));
    runs += 1;
  }
  return runs;
}

export async function readBulkRun(db: Database, id: string): Promise<BulkRunRow | undefined> {
  return readRun(db, id);
}
