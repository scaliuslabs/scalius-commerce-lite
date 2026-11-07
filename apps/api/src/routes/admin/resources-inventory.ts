// Stock documents in the stable app API (operation-registry/README.md),
// mounted at /admin/resources: per-location stock levels, suppliers,
// purchase orders and transfers, for ERP and inventory-sync apps. Each write
// calls the same inventory service the dashboard's beta routes call
// (`@scalius/core/modules/inventory`); stock moves only through its
// ledger-v2 stock commands, keyed by the caller's Idempotency-Key. Purchase
// orders and transfers answer the sealed representations a webhook delivery
// carries (`purchase_order`, `inventory_transfer`); money is integer minor
// units of the purchase order's `currency`. Lists page by cursor in
// (updatedAt, id) order; `updatedSince` starts a sync.
import { createRoute, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { and, asc, eq, gt, gte, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
  INVENTORY_TRANSFER_STATUSES,
  PURCHASE_ORDER_STATUSES,
  SUPPLIER_STATUSES,
  inventoryLevels,
  inventoryTransfers,
  productVariants,
  purchaseOrders,
  suppliers,
} from "@scalius/database/schema";
import {
  cancelPurchaseOrder,
  cancelTransfer,
  createPurchaseOrder,
  createSupplier,
  createTransfer,
  getSupplier,
  INVENTORY_TRANSFER_MAX_LINES,
  markPurchaseOrderOrdered,
  PURCHASE_ORDER_MAX_LINES,
  receivePurchaseOrder,
  receiveTransfer,
  shipTransfer,
  updatePurchaseOrder,
  updateSupplier,
  updateTransfer,
  UNIT_COST_MAX,
  type SupplierRecord,
} from "@scalius/core/modules/inventory";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { inJsonArray } from "@scalius/core/utils/in-json-array";
import { keysetCondition, keysetOrderBy } from "@scalius/core/utils/keyset";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor, MAX_MINOR_AMOUNT } from "@scalius/shared/money";
import { formatNumber } from "@scalius/shared/locale-format";
import type { ListCursorShape } from "@scalius/shared/pagination";
import { adminRouter } from "./admin-router";
import { idempotencyKeyHeaderSchema, scopedRequestKey } from "./idempotency";
import { readInventoryTransferRepresentations, readPurchaseOrderRepresentations } from "../../events/representations";
import { conflictResponse, errorResponses, namedSharedSchema, successEnvelope } from "../../schemas/responses";
import { isoTimestampSchema } from "../../schemas/timestamps";
import { nextCursorSchema } from "../../utils/bounded-page";
import { created, ok } from "../../utils/api-response";
import { NotFoundError, ValidationError } from "../../utils/api-error";
import { epochSeconds, keysetRowsPage, resourcePage, resourcePageQueryWith, updatedOrder, updatedSeconds } from "../../utils/resource-page";
import { requestActorId } from "./request-actor";

const app = adminRouter();

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};
app.use("*", noStore);

const TAG = "App API - Inventory";
const PurchaseOrderResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.purchase_order, "PurchaseOrderResource");
const InventoryTransferResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.inventory_transfer, "InventoryTransferResource");

/** Variant ids one level list may name: one bound value, read in one wave (D1's limits). */
const MAX_LEVEL_VARIANT_IDS = 90;

const idParam = z.object({ id: z.string().min(1).max(128) });
const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404], 429: errorResponses[429], 500: errorResponses[500] };
const writeResponses = { ...errorResponses, 409: conflictResponse };

const expectedRevision = z.number().int().min(1).openapi({ description: "The `revision` you read: a write to a record that changed since is refused with 409 and changes nothing." });

/** A stock command's key: required, one key moves stock once. */
const stockCommandHeaders = z.object({
  "idempotency-key": idempotencyKeyHeaderSchema.shape["idempotency-key"].unwrap().openapi({
    description: "Required: one key moves the stock once; a repeat returns the first result.",
  }),
});

/** The largest cost the inventory service keeps, in minor units of a currency with `places` decimals. */
const unitCostLimitMinor = (places: number) => Math.min(MAX_MINOR_AMOUNT, UNIT_COST_MAX * 10 ** places);
const COST_BOUND = `At most ${formatNumber(UNIT_COST_MAX, "en")} in major units of the purchase order's currency (${formatNumber(unitCostLimitMinor(2), "en")} minor units for a currency of two decimals); a larger value is refused with validation_error.`;
const minorCost = (description: string) => z.number().int().min(0).max(MAX_MINOR_AMOUNT).openapi({ description: `${description} ${COST_BOUND}` });

/**
 * Who acts on a stock document: staff by their id; an app as itself
 * (`app:<id>`, as its return writes record it), never the Super Admin who
 * approved it. It becomes the document's `createdBy`, its stock command's
 * and each ledger movement's `created_by`.
 */
const actorId = (c: Context): string | null => requestActorId(c);

// ─── Levels ──────────────────────────────────────────────────────────────────

const InventoryLevelResource = z.object({
  variantId: z.string(),
  productId: z.string(),
  sku: z.string(),
  locationId: z.string(),
  onHand: z.number().int().openapi({ description: "Units physically at the location. A SKU's levels sum to its on-hand stock; reservations are not per location." }),
  stockVersion: z.number().int().openapi({ description: "The SKU's stock version now: the `expectedStockVersion` its stock writes (`inventory.adjust`, `inventory.set_stock`) take." }),
  updatedAt: isoTimestampSchema.openapi({ description: "When units last moved in or out of this location." }),
}).openapi("InventoryLevelResource");

/** A level's place in the list: when units last moved, then its key (the SKU, then the location); `inventory_levels_updated_idx` serves it. */
const LEVEL_CURSOR: ListCursorShape = { sort: "updatedAt", direction: "asc", kinds: ["number", "text"] };

function levelsAfter(cursor: { values: readonly unknown[]; id: string }): SQL {
  const [at, variantId] = cursor.values as [number, string];
  const updated = sql`${inventoryLevels.updatedAt}`;
  return and(
    gte(updated, at),
    or(
      gt(updated, at),
      and(eq(updated, at), gt(inventoryLevels.variantId, variantId)),
      and(eq(updated, at), eq(inventoryLevels.variantId, variantId), gt(inventoryLevels.locationId, cursor.id)),
    ),
  )!;
}

const levelsQuery = z.object({
  ...resourcePageQueryWith(250, 100),
  variantIds: z.string().max(MAX_LEVEL_VARIANT_IDS * 129).optional()
    .transform((value) => value === undefined ? undefined : [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))])
    .refine((ids) => ids === undefined || (ids.length >= 1 && ids.length <= MAX_LEVEL_VARIANT_IDS && ids.every((id) => id.length <= 128)), {
      message: `Name 1 to ${MAX_LEVEL_VARIANT_IDS} variant ids, comma separated.`,
    })
    .openapi({ type: "string", description: `Only these SKUs: 1 to ${MAX_LEVEL_VARIANT_IDS} variant ids, comma separated.` }),
  productId: z.string().min(1).max(128).optional().openapi({ description: "Only this product's SKUs." }),
  locationId: z.string().min(1).max(128).optional().openapi({ description: "Only this location (`inventory_locations.list`)." }),
});

app.openapi(createRoute({
  operationId: "dashboard.resources.inventory_levels.list",
  method: "get",
  path: "/inventory-levels",
  tags: [TAG],
  summary: "List stock levels per SKU per location, least recently changed first",
  description: "Each SKU's on-hand units at each location that has held them, in (updatedAt, SKU and location) order. A level moves only through stock movements (adjustments, receipts, transfers, fulfilments); start a sync with updatedSince and follow nextCursor.",
  request: { query: levelsQuery },
  responses: {
    200: { description: "A page of levels", content: { "application/json": { schema: successEnvelope(z.object({ levels: z.array(InventoryLevelResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [];
  if (query.variantIds) where.push(inJsonArray(inventoryLevels.variantId, query.variantIds));
  if (query.locationId) where.push(eq(inventoryLevels.locationId, query.locationId));
  if (query.productId) where.push(eq(productVariants.productId, query.productId));
  if (query.updatedSince) where.push(gte(sql`${inventoryLevels.updatedAt}`, epochSeconds(query.updatedSince)));
  const page = await keysetRowsPage({
    shape: LEVEL_CURSOR,
    after: levelsAfter,
    cursor: query.cursor,
    limit: query.limit,
    where,
    rows: (condition, limit) => db.select({
      variantId: inventoryLevels.variantId,
      productId: productVariants.productId,
      sku: productVariants.sku,
      locationId: inventoryLevels.locationId,
      onHand: inventoryLevels.onHand,
      stockVersion: productVariants.stockVersion,
      updatedAt: inventoryLevels.updatedAt,
    }).from(inventoryLevels)
      .innerJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
      .where(condition)
      .orderBy(asc(inventoryLevels.updatedAt), asc(inventoryLevels.variantId), asc(inventoryLevels.locationId))
      .limit(limit).all(),
    load: (rows) => rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
    position: (level) => ({ values: [updatedSeconds(level.updatedAt), level.variantId], id: level.locationId }),
  });
  return ok(c, { levels: page.items, nextCursor: page.nextCursor });
});

// ─── Suppliers ───────────────────────────────────────────────────────────────

/** A supplier: a business the store buys from. Its contact is the supplier's, not a buyer's. */
const SupplierResource = z.object({
  id: z.string(),
  name: z.string(),
  contactName: z.string().nullable().openapi({ description: "The person to speak to at the supplier." }),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.enum(SUPPLIER_STATUSES),
  revision: z.number().int(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).openapi("SupplierResource");
type SupplierResourceValue = z.infer<typeof SupplierResource>;

function supplierResource(record: Pick<SupplierRecord, "id" | "name" | "contactName" | "phone" | "email" | "notes" | "status" | "version" | "createdAt" | "updatedAt">): SupplierResourceValue {
  return {
    id: record.id,
    name: record.name,
    contactName: record.contactName,
    phone: record.phone,
    email: record.email,
    notes: record.notes,
    status: record.status,
    revision: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

const supplierEnvelope = successEnvelope(z.object({ supplier: SupplierResource }));
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const supplierFields = {
  contactName: optionalText(120),
  phone: optionalText(32),
  email: z.string().trim().email().max(254).nullable().optional(),
  notes: optionalText(2000),
};

app.openapi(createRoute({
  operationId: "dashboard.resources.suppliers.list",
  method: "get",
  path: "/suppliers",
  tags: [TAG],
  summary: "List suppliers, least recently updated first",
  description: "Suppliers active and archived, in (updatedAt, id) order. Start a sync with updatedSince and follow nextCursor.",
  request: {
    query: z.object({
      ...resourcePageQueryWith(50, 20),
      status: z.enum(SUPPLIER_STATUSES).optional().openapi({ description: "Only suppliers in this status." }),
    }),
  },
  responses: {
    200: { description: "A page of suppliers", content: { "application/json": { schema: successEnvelope(z.object({ suppliers: z.array(SupplierResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [];
  if (query.status) where.push(eq(suppliers.status, query.status));
  if (query.updatedSince) where.push(gte(sql`${suppliers.updatedAt}`, epochSeconds(query.updatedSince)));
  const order = updatedOrder(suppliers.updatedAt, suppliers.id);
  const page = await keysetRowsPage({
    shape: { sort: "updatedAt", direction: "asc", kinds: ["number"] },
    after: (cursor) => keysetCondition(order, cursor),
    cursor: query.cursor,
    limit: query.limit,
    where,
    rows: (condition, limit) => db.select().from(suppliers).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: (rows) => rows.map(supplierResource),
    position: (supplier) => ({ values: [updatedSeconds(supplier.updatedAt)], id: supplier.id }),
  });
  return ok(c, { suppliers: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.suppliers.get",
  method: "get",
  path: "/suppliers/{id}",
  tags: [TAG],
  summary: "Get a supplier",
  request: { params: idParam },
  responses: {
    200: { description: "The supplier", content: { "application/json": { schema: supplierEnvelope } } },
    ...readResponses,
  },
}), async (c) => ok(c, { supplier: supplierResource(await getSupplier(c.get("db"), c.req.valid("param").id)) }));

app.openapi(createRoute({
  operationId: "dashboard.resources.suppliers.create",
  method: "post",
  path: "/suppliers",
  tags: [TAG],
  summary: "Add a supplier",
  description: "A business the store buys stock from, for purchase orders to name.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: z.object({ name: z.string().trim().min(1).max(120), ...supplierFields }).strict() } } },
  },
  responses: {
    201: { description: "The supplier", content: { "application/json": { schema: supplierEnvelope } } },
    ...writeResponses,
  },
}), async (c) => created(c, { supplier: supplierResource(await createSupplier(c.get("db"), c.req.valid("json"))) }));

app.openapi(createRoute({
  operationId: "dashboard.resources.suppliers.update",
  method: "patch",
  path: "/suppliers/{id}",
  tags: [TAG],
  summary: "Edit a supplier",
  description: "Changes the fields sent (null clears one) at the revision read.",
  request: {
    params: idParam,
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ expectedRevision, name: z.string().trim().min(1).max(120).optional(), ...supplierFields }).strict() } },
    },
  },
  responses: {
    200: { description: "The supplier", content: { "application/json": { schema: supplierEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const id = c.req.valid("param").id;
  const { expectedRevision: version, ...changes } = c.req.valid("json");
  const current = await getSupplier(db, id);
  const pick = <K extends keyof typeof changes>(key: K, fallback: string | null) => changes[key] !== undefined ? changes[key] : fallback;
  const updated = await updateSupplier(db, id, {
    name: changes.name ?? current.name,
    contactName: pick("contactName", current.contactName),
    phone: pick("phone", current.phone),
    email: pick("email", current.email),
    notes: pick("notes", current.notes),
    expectedVersion: version,
  });
  return ok(c, { supplier: supplierResource(updated) });
});

const revisionBody = z.object({ expectedRevision }).strict();

// ─── Purchase orders ─────────────────────────────────────────────────────────

const purchaseOrderEnvelope = successEnvelope(z.object({ purchaseOrder: PurchaseOrderResource }));
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "Use a date like 2026-10-31.");

async function purchaseOrderAnswer(c: Context, id: string) {
  const [purchaseOrder] = await readPurchaseOrderRepresentations(c.get("db"), [id]);
  if (!purchaseOrder) throw new NotFoundError("Purchase order not found");
  return { purchaseOrder };
}

const purchaseOrderLineInput = z.object({
  variantId: z.string().trim().min(1).max(128),
  quantity: z.number().int().min(1).max(1_000_000),
  unitCostMinor: minorCost("Cost per unit, in minor units of the store currency (the purchase order's `currency`)."),
}).strict();

const purchaseOrderHeaderInput = {
  supplierId: z.string().trim().min(1).max(128).nullable().optional().openapi({ description: "An active supplier (`suppliers.list`), or null for none." }),
  expectedOn: dateOnly.nullable().optional().openapi({ description: "Expected arrival date (YYYY-MM-DD)." }),
  reference: optionalText(100).openapi({ description: "The supplier's invoice or order reference." }),
  shippingMinor: minorCost("Shipping charged by the supplier, in minor units.").optional(),
  otherCostsMinor: minorCost("Other charges, in minor units.").optional(),
  taxMinor: minorCost("Tax charged by the supplier, in minor units.").optional(),
};

/** Refuses a cost above what the service keeps for this currency, naming the field. */
function assertCostBounds(input: { shippingMinor?: number; otherCostsMinor?: number; taxMinor?: number; lines?: { unitCostMinor: number }[] }, currencyCode: string): void {
  const limit = unitCostLimitMinor(getDecimalPlaces(currencyCode));
  const issues = [
    ...(["shippingMinor", "otherCostsMinor", "taxMinor"] as const).filter((field) => (input[field] ?? 0) > limit).map((field) => ({ path: [field] })),
    ...(input.lines ?? []).flatMap((line, index) => line.unitCostMinor > limit ? [{ path: ["lines", index, "unitCostMinor"] }] : []),
  ].map((issue) => ({ ...issue, code: "too_big", maximum: limit, message: `At most ${limit} minor units of ${currencyCode}.` }));
  if (issues.length > 0) throw new ValidationError(`A cost is over the most the store keeps (${limit} minor units of ${currencyCode}).`, { issues });
}

/** Minor units of `currencyCode` as the inventory service's major-unit cost (exact: it converts back to the same minor units). */
function majorCosts<T extends { shippingMinor?: number; otherCostsMinor?: number; taxMinor?: number; lines?: z.infer<typeof purchaseOrderLineInput>[] }>(
  input: T,
  currencyCode: string,
) {
  const places = getDecimalPlaces(currencyCode);
  const major = (minor: number | undefined) => minor === undefined ? undefined : fromMinor(minor, places);
  return {
    ...(input.shippingMinor !== undefined ? { shipping: major(input.shippingMinor) } : {}),
    ...(input.otherCostsMinor !== undefined ? { otherCosts: major(input.otherCostsMinor) } : {}),
    ...(input.taxMinor !== undefined ? { tax: major(input.taxMinor) } : {}),
    ...(input.lines !== undefined
      ? { lines: input.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity, unitCost: fromMinor(line.unitCostMinor, places) })) }
      : {}),
  };
}

app.openapi(createRoute({
  operationId: "dashboard.resources.purchase_orders.list",
  method: "get",
  path: "/purchase-orders",
  tags: [TAG],
  summary: "List purchase orders, least recently updated first",
  description: "Purchase orders to suppliers as webhooks carry them (PurchaseOrderResource), in (updatedAt, id) order, money in minor units of `currency`. Start a sync with updatedSince and follow nextCursor.",
  request: {
    query: z.object({
      ...resourcePageQueryWith(50, 20),
      status: z.enum(PURCHASE_ORDER_STATUSES).optional().openapi({ description: "Only purchase orders in this status." }),
      supplierId: z.string().min(1).max(128).optional(),
      locationId: z.string().min(1).max(128).optional().openapi({ description: "Only purchase orders arriving at this location." }),
    }),
  },
  responses: {
    200: { description: "A page of purchase orders", content: { "application/json": { schema: successEnvelope(z.object({ purchaseOrders: z.array(PurchaseOrderResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [];
  if (query.status) where.push(eq(purchaseOrders.status, query.status));
  if (query.supplierId) where.push(eq(purchaseOrders.supplierId, query.supplierId));
  if (query.locationId) where.push(eq(purchaseOrders.destinationLocationId, query.locationId));
  if (query.updatedSince) where.push(gte(sql`${purchaseOrders.updatedAt}`, epochSeconds(query.updatedSince)));
  const order = updatedOrder(purchaseOrders.updatedAt, purchaseOrders.id);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: (ids) => readPurchaseOrderRepresentations(db, ids),
  });
  return ok(c, { purchaseOrders: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.purchase_orders.get",
  method: "get",
  path: "/purchase-orders/{id}",
  tags: [TAG],
  summary: "Get a purchase order",
  description: "The purchase order as webhooks carry it: its lines with ordered and received quantities and unit costs in minor units of `currency`.",
  request: { params: idParam },
  responses: {
    200: { description: "The purchase order", content: { "application/json": { schema: purchaseOrderEnvelope } } },
    ...readResponses,
  },
}), async (c) => ok(c, await purchaseOrderAnswer(c, c.req.valid("param").id)));

app.openapi(createRoute({
  operationId: "dashboard.resources.purchase_orders.create",
  method: "post",
  path: "/purchase-orders",
  tags: [TAG],
  summary: "Create a draft purchase order",
  description: `A draft to a supplier, in the store currency. Lines are live physical SKUs, each once, at most ${PURCHASE_ORDER_MAX_LINES}; the destination is the default location when omitted. Nothing is incoming until purchase_orders.mark_ordered.`,
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            ...purchaseOrderHeaderInput,
            destinationLocationId: z.string().trim().min(1).max(128).optional().openapi({ description: "Where the goods arrive (an active location); the default location when omitted." }),
            lines: z.array(purchaseOrderLineInput).max(PURCHASE_ORDER_MAX_LINES).optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    201: { description: "The purchase order", content: { "application/json": { schema: purchaseOrderEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const currency = await readStoreCurrency(db);
  assertCostBounds(body, currency.code);
  const draft = await createPurchaseOrder(db, {
    ...(body.supplierId !== undefined ? { supplierId: body.supplierId } : {}),
    ...(body.destinationLocationId !== undefined ? { destinationLocationId: body.destinationLocationId } : {}),
    ...(body.expectedOn !== undefined ? { expectedOn: body.expectedOn } : {}),
    ...(body.reference !== undefined ? { reference: body.reference } : {}),
    ...majorCosts(body, currency.code),
  }, actorId(c));
  return created(c, await purchaseOrderAnswer(c, draft.id));
});

app.openapi(createRoute({
  operationId: "dashboard.resources.purchase_orders.update",
  method: "patch",
  path: "/purchase-orders/{id}",
  tags: [TAG],
  summary: "Edit a purchase order",
  description: "Changes the fields sent at the revision read. A draft takes any change (`lines` replaces its lines); once ordered only the supplier, expected date, reference, shipping, other costs and tax change. Money is minor units of the purchase order's `currency`.",
  request: {
    params: idParam,
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            expectedRevision,
            ...purchaseOrderHeaderInput,
            destinationLocationId: z.string().trim().min(1).max(128).optional().openapi({ description: "Drafts only: where the goods arrive." }),
            lines: z.array(purchaseOrderLineInput).max(PURCHASE_ORDER_MAX_LINES).optional().openapi({ description: "Drafts only: replaces every line." }),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "The purchase order", content: { "application/json": { schema: purchaseOrderEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const id = c.req.valid("param").id;
  const body = c.req.valid("json");
  const header = await db.select({ currencyCode: purchaseOrders.currencyCode }).from(purchaseOrders).where(eq(purchaseOrders.id, id)).get();
  if (!header) throw new NotFoundError("Purchase order not found");
  assertCostBounds(body, header.currencyCode);
  await updatePurchaseOrder(db, id, {
    expectedRevision: body.expectedRevision,
    ...(body.supplierId !== undefined ? { supplierId: body.supplierId } : {}),
    ...(body.destinationLocationId !== undefined ? { destinationLocationId: body.destinationLocationId } : {}),
    ...(body.expectedOn !== undefined ? { expectedOn: body.expectedOn } : {}),
    ...(body.reference !== undefined ? { reference: body.reference } : {}),
    ...majorCosts(body, header.currencyCode),
  });
  return ok(c, await purchaseOrderAnswer(c, id));
});

app.openapi(createRoute({
  operationId: "dashboard.resources.purchase_orders.mark_ordered",
  method: "post",
  path: "/purchase-orders/{id}/mark-ordered",
  tags: [TAG],
  summary: "Mark a draft purchase order as ordered",
  description: "The order went to the supplier: its lines become incoming stock at the destination and can no longer change.",
  request: { params: idParam, headers: idempotencyKeyHeaderSchema, body: { required: true, content: { "application/json": { schema: revisionBody } } } },
  responses: {
    200: { description: "The purchase order", content: { "application/json": { schema: purchaseOrderEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const id = c.req.valid("param").id;
  await markPurchaseOrderOrdered(c.get("db"), id, c.req.valid("json").expectedRevision);
  return ok(c, await purchaseOrderAnswer(c, id));
});

const receiptLines = (max: number) => z.array(z.object({
  lineId: z.string().trim().min(1).max(128).openapi({ description: "The line's `id` in the representation." }),
  quantity: z.number().int().min(1).max(1_000_000),
}).strict()).min(1).max(max);

app.openapi(createRoute({
  operationId: "dashboard.resources.purchase_orders.receive",
  method: "post",
  path: "/purchase-orders/{id}/receive",
  tags: [TAG],
  summary: "Receive stock on a purchase order",
  description: "Books some or all of the open quantities at the destination in one atomic write: a ledger `received` movement per SKU with its stock version, the receipt's unit costs and the new status. `updateCost` moves each SKU's unit cost to the weighted average of its on-hand units and the received ones. One Idempotency-Key receives once: a repeat returns the first result and moves nothing.",
  request: {
    params: idParam,
    headers: stockCommandHeaders,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            lines: receiptLines(PURCHASE_ORDER_MAX_LINES),
            updateCost: z.boolean().default(false),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "The purchase order", content: { "application/json": { schema: purchaseOrderEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const id = c.req.valid("param").id;
  const body = c.req.valid("json");
  const operationKey = await scopedRequestKey(c, "dashboard.resources.purchase_orders.receive", c.req.valid("header")["idempotency-key"]);
  await receivePurchaseOrder(c.get("db"), id, { operationKey, lines: body.lines, updateCost: body.updateCost }, actorId(c));
  return ok(c, await purchaseOrderAnswer(c, id));
});

app.openapi(createRoute({
  operationId: "dashboard.resources.purchase_orders.cancel",
  method: "post",
  path: "/purchase-orders/{id}/cancel",
  tags: [TAG],
  summary: "Cancel a purchase order",
  description: "Stops what is still to come; units already received stay in stock.",
  request: { params: idParam, headers: idempotencyKeyHeaderSchema, body: { required: true, content: { "application/json": { schema: revisionBody } } } },
  responses: {
    200: { description: "The purchase order", content: { "application/json": { schema: purchaseOrderEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const id = c.req.valid("param").id;
  await cancelPurchaseOrder(c.get("db"), id, c.req.valid("json").expectedRevision);
  return ok(c, await purchaseOrderAnswer(c, id));
});

// ─── Transfers ───────────────────────────────────────────────────────────────

const transferEnvelope = successEnvelope(z.object({ transfer: InventoryTransferResource }));

async function transferAnswer(c: Context, id: string) {
  const [transfer] = await readInventoryTransferRepresentations(c.get("db"), [id]);
  if (!transfer) throw new NotFoundError("Transfer not found");
  return { transfer };
}

const transferLineInput = z.object({
  variantId: z.string().trim().min(1).max(128),
  quantity: z.number().int().min(1).max(1_000_000),
}).strict();
const locationId = (description: string) => z.string().trim().min(1).max(128).openapi({ description });

/**
 * A location's transfers, from or to it, in (updatedAt, id) order: one walk
 * of the origin index and one of the destination index (an OR of the two
 * would sort the table), merged. A transfer has two different locations, so
 * no id is in both.
 */
async function transfersAtLocation(db: Database, locationId: string, condition: SQL | undefined, limit: number): Promise<{ id: string }[]> {
  const order = updatedOrder(inventoryTransfers.updatedAt, inventoryTransfers.id);
  const arm = (column: typeof inventoryTransfers.originLocationId | typeof inventoryTransfers.destinationLocationId) => db.select({ id: inventoryTransfers.id, updatedAt: inventoryTransfers.updatedAt })
    .from(inventoryTransfers).where(and(eq(column, locationId), condition)).orderBy(...keysetOrderBy(order)).limit(limit);
  const [from, to] = await db.batch([arm(inventoryTransfers.originLocationId), arm(inventoryTransfers.destinationLocationId)]);
  return [...from, ...to]
    .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime() || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .slice(0, limit)
    .map((row) => ({ id: row.id }));
}

app.openapi(createRoute({
  operationId: "dashboard.resources.inventory_transfers.list",
  method: "get",
  path: "/inventory-transfers",
  tags: [TAG],
  summary: "List stock transfers, least recently updated first",
  description: "Transfers between locations as webhooks carry them (InventoryTransferResource), in (updatedAt, id) order. Start a sync with updatedSince and follow nextCursor.",
  request: {
    query: z.object({
      ...resourcePageQueryWith(50, 20),
      status: z.enum(INVENTORY_TRANSFER_STATUSES).optional().openapi({ description: "Only transfers in this status." }),
      locationId: z.string().min(1).max(128).optional().openapi({ description: "Only transfers from or to this location." }),
    }),
  },
  responses: {
    200: { description: "A page of transfers", content: { "application/json": { schema: successEnvelope(z.object({ transfers: z.array(InventoryTransferResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [];
  if (query.status) where.push(eq(inventoryTransfers.status, query.status));
  if (query.updatedSince) where.push(gte(sql`${inventoryTransfers.updatedAt}`, epochSeconds(query.updatedSince)));
  const order = updatedOrder(inventoryTransfers.updatedAt, inventoryTransfers.id);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => query.locationId
      ? transfersAtLocation(db, query.locationId, condition, limit)
      : db.select({ id: inventoryTransfers.id }).from(inventoryTransfers).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: (ids) => readInventoryTransferRepresentations(db, ids),
  });
  return ok(c, { transfers: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.inventory_transfers.get",
  method: "get",
  path: "/inventory-transfers/{id}",
  tags: [TAG],
  summary: "Get a stock transfer",
  description: "The transfer as webhooks carry it: its lines with shipped, received and returned quantities.",
  request: { params: idParam },
  responses: {
    200: { description: "The transfer", content: { "application/json": { schema: transferEnvelope } } },
    ...readResponses,
  },
}), async (c) => ok(c, await transferAnswer(c, c.req.valid("param").id)));

app.openapi(createRoute({
  operationId: "dashboard.resources.inventory_transfers.create",
  method: "post",
  path: "/inventory-transfers",
  tags: [TAG],
  summary: "Create a draft stock transfer",
  description: `Between two different active locations; lines are live physical SKUs, each once, at most ${INVENTORY_TRANSFER_MAX_LINES}. Nothing moves until inventory_transfers.ship.`,
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            originLocationId: locationId("Where the units leave from."),
            destinationLocationId: locationId("Where they arrive."),
            expectedOn: dateOnly.nullable().optional().openapi({ description: "Expected arrival date (YYYY-MM-DD)." }),
            reference: optionalText(100),
            lines: z.array(transferLineInput).max(INVENTORY_TRANSFER_MAX_LINES).optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    201: { description: "The transfer", content: { "application/json": { schema: transferEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const draft = await createTransfer(c.get("db"), c.req.valid("json"), actorId(c));
  return created(c, await transferAnswer(c, draft.id));
});

app.openapi(createRoute({
  operationId: "dashboard.resources.inventory_transfers.update",
  method: "patch",
  path: "/inventory-transfers/{id}",
  tags: [TAG],
  summary: "Edit a draft stock transfer",
  description: "Drafts only: changes the fields sent at the revision read; `lines` replaces every line.",
  request: {
    params: idParam,
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            expectedRevision,
            originLocationId: locationId("Where the units leave from.").optional(),
            destinationLocationId: locationId("Where they arrive.").optional(),
            expectedOn: dateOnly.nullable().optional(),
            reference: optionalText(100),
            lines: z.array(transferLineInput).max(INVENTORY_TRANSFER_MAX_LINES).optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "The transfer", content: { "application/json": { schema: transferEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const id = c.req.valid("param").id;
  await updateTransfer(c.get("db"), id, c.req.valid("json"));
  return ok(c, await transferAnswer(c, id));
});

app.openapi(createRoute({
  operationId: "dashboard.resources.inventory_transfers.ship",
  method: "post",
  path: "/inventory-transfers/{id}/ship",
  tags: [TAG],
  summary: "Ship a stock transfer",
  description: "Every line leaves the origin in one atomic write (ledger `transfer_out` movements). Units in transit are out of both locations and of the SKU's stock, so buyers cannot buy them. Refused before writing when the origin lacks a line's units or they are committed to orders.",
  request: { params: idParam, headers: stockCommandHeaders, body: { required: true, content: { "application/json": { schema: revisionBody } } } },
  responses: {
    200: { description: "The transfer", content: { "application/json": { schema: transferEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const id = c.req.valid("param").id;
  const operationKey = await scopedRequestKey(c, "dashboard.resources.inventory_transfers.ship", c.req.valid("header")["idempotency-key"]);
  await shipTransfer(c.get("db"), id, { operationKey, expectedRevision: c.req.valid("json").expectedRevision }, actorId(c));
  return ok(c, await transferAnswer(c, id));
});

app.openapi(createRoute({
  operationId: "dashboard.resources.inventory_transfers.receive",
  method: "post",
  path: "/inventory-transfers/{id}/receive",
  tags: [TAG],
  summary: "Receive units of a stock transfer",
  description: "Books some or all in-transit units at the destination (ledger `transfer_in` movements) in one atomic write. One Idempotency-Key receives once: a repeat returns the first result and moves nothing.",
  request: {
    params: idParam,
    headers: stockCommandHeaders,
    body: { required: true, content: { "application/json": { schema: z.object({ lines: receiptLines(INVENTORY_TRANSFER_MAX_LINES) }).strict() } } },
  },
  responses: {
    200: { description: "The transfer", content: { "application/json": { schema: transferEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const id = c.req.valid("param").id;
  const operationKey = await scopedRequestKey(c, "dashboard.resources.inventory_transfers.receive", c.req.valid("header")["idempotency-key"]);
  await receiveTransfer(c.get("db"), id, { operationKey, lines: c.req.valid("json").lines }, actorId(c));
  return ok(c, await transferAnswer(c, id));
});

app.openapi(createRoute({
  operationId: "dashboard.resources.inventory_transfers.cancel",
  method: "post",
  path: "/inventory-transfers/{id}/cancel",
  tags: [TAG],
  summary: "Cancel a stock transfer",
  description: "A draft just closes. One in transit returns every unit still on the road to the origin (ledger `transfer_in` there) in one atomic write.",
  request: { params: idParam, headers: stockCommandHeaders, body: { required: true, content: { "application/json": { schema: revisionBody } } } },
  responses: {
    200: { description: "The transfer", content: { "application/json": { schema: transferEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const id = c.req.valid("param").id;
  const operationKey = await scopedRequestKey(c, "dashboard.resources.inventory_transfers.cancel", c.req.valid("header")["idempotency-key"]);
  await cancelTransfer(c.get("db"), id, { operationKey, expectedRevision: c.req.valid("json").expectedRevision }, actorId(c));
  return ok(c, await transferAnswer(c, id));
});

export { app as adminResourceInventoryRoutes };
