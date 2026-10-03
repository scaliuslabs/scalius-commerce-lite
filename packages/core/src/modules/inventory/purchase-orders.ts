// Purchase orders (migration 0109): draft → ordered → partially received →
// received, or cancelled.
//
// A draft is fully editable (header and lines) and can be deleted. Once
// ordered, its lines are fixed (triggers enforce it) and its open quantity
// (ordered − received) is the SKU's incoming stock at the destination.
// Receiving books `received` ledger-v2 movements at the destination in the
// same batch as the stockVersion CAS (stock-commands.ts), records each
// receipt line's unit cost (the cost history) and, when the merchant asks,
// moves the SKU's unit cost to the weighted average. Cancelling an ordered or
// partially received PO stops the rest coming; received units stay.
// Every write advances `revision` exactly once (one event each); edits and
// status changes require the revision the merchant saw.

import { and, asc, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { BatchItem } from "drizzle-orm/batch";
import { buildBatchGuard, chunkRowsForD1, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import {
  inventoryCommands,
  inventoryLocations,
  productVariants,
  products,
  purchaseOrderLines,
  purchaseOrderReceiptLines,
  purchaseOrders,
  suppliers,
  user as adminUsers,
  PURCHASE_ORDER_STATUSES,
  type PurchaseOrderStatus,
} from "@scalius/database/schema";
import { fromMinor } from "@scalius/shared/money";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { digitalStockError, isDigitalKind, variantOptionLabelSql } from "../products";
import { readStoreCurrency, type StoreCurrency } from "../settings";
import { inventoryOperationKeySchema } from "./inventory.validation";
import { resolveActiveInventoryLocation } from "./locations";
import { assertActiveSupplier } from "./suppliers";
import { addedQuantitySql, commandActorUserIdSql, executeStockCommand, idsFromJsonSql, readStockCommandSkus, type StockCommandEdge } from "./stock-commands";
import { unitCostAmountSchema, unitCostToMinor } from "./unit-costs";
import { spreadsheetSafeCsvCell } from "@scalius/shared/spreadsheet-csv";

export const PURCHASE_ORDER_MAX_LINES = 100;
export const PURCHASE_ORDER_OPEN_STATUSES = ["ordered", "partially_received"] as const satisfies readonly PurchaseOrderStatus[];
const STALE = "PURCHASE_ORDER_STALE";
const NUMBER_START = 1000;

// ─────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────

const dateOnlySchema = z.string().trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), "Use a real calendar date.");

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const purchaseOrderLineInputSchema = z.object({
  variantId: z.string().trim().min(1).max(100),
  quantity: z.number().int().min(1).max(1_000_000),
  /** Cost per unit in major units of the store currency. */
  unitCost: unitCostAmountSchema,
});

const headerShape = {
  supplierId: z.string().trim().min(1).max(100).nullable().optional(),
  /** Where the goods arrive; the default location when omitted on create. */
  destinationLocationId: z.string().trim().min(1).max(100).optional(),
  expectedOn: dateOnlySchema.nullable().optional(),
  reference: optionalText(100),
  notes: optionalText(2000),
  shipping: unitCostAmountSchema.optional(),
  otherCosts: unitCostAmountSchema.optional(),
  tax: unitCostAmountSchema.optional(),
};

export const createPurchaseOrderSchema = z.object({
  ...headerShape,
  lines: z.array(purchaseOrderLineInputSchema).max(PURCHASE_ORDER_MAX_LINES).optional(),
});
export type CreatePurchaseOrderInput = z.input<typeof createPurchaseOrderSchema>;

export const updatePurchaseOrderSchema = z.object({
  ...headerShape,
  /** Replaces every line (drafts only). Omit to keep the lines. */
  lines: z.array(purchaseOrderLineInputSchema).max(PURCHASE_ORDER_MAX_LINES).optional(),
  expectedRevision: z.number().int().min(1),
});
export type UpdatePurchaseOrderInput = z.input<typeof updatePurchaseOrderSchema>;

export const receivePurchaseOrderSchema = z.object({
  operationKey: inventoryOperationKeySchema,
  lines: z.array(z.object({
    lineId: z.string().trim().min(1).max(100),
    quantity: z.number().int().min(1).max(1_000_000),
  })).min(1).max(PURCHASE_ORDER_MAX_LINES),
  /** Move each received SKU's cost to the weighted average of its on-hand units and these. */
  updateCost: z.boolean().optional().default(false),
});
export type ReceivePurchaseOrderInput = z.input<typeof receivePurchaseOrderSchema>;

export const listPurchaseOrdersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum([...PURCHASE_ORDER_STATUSES, "open", "all"]).optional().default("all"),
  supplierId: z.string().trim().min(1).max(100).optional(),
  locationId: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});
export type ListPurchaseOrdersQuery = z.input<typeof listPurchaseOrdersQuerySchema>;

function parse<T>(schema: z.ZodType<T>, input: unknown, fallback = "Invalid purchase order"): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}

// ─────────────────────────────────────────
// Read models
// ─────────────────────────────────────────

export interface PurchaseOrderSummary {
  id: string;
  number: number;
  displayNumber: string;
  status: PurchaseOrderStatus;
  supplier: { id: string; name: string } | null;
  destination: { id: string; name: string };
  expectedOn: string | null;
  reference: string | null;
  currencyCode: string;
  lineCount: number;
  quantity: number;
  receivedQuantity: number;
  subtotal: number;
  total: number;
  revision: number;
  orderedAt: Date | null;
  receivedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PurchaseOrderLineView {
  id: string;
  variantId: string;
  productId: string;
  productName: string | null;
  sku: string;
  barcode: string | null;
  optionLabel: string | null;
  /** The SKU was removed from its product (it cannot be received until restored). */
  retired: boolean;
  position: number;
  quantity: number;
  receivedQuantity: number;
  openQuantity: number;
  unitCost: number;
  lineTotal: number;
  /** The SKU's unit cost now (null when it has none). */
  currentCost: number | null;
}

export interface PurchaseOrderReceiptView {
  operationKey: string;
  createdAt: Date;
  actorName: string;
  lines: Array<{
    lineId: string;
    variantId: string;
    sku: string;
    quantity: number;
    unitCost: number;
    costBefore: number | null;
    costAfter: number | null;
    costUpdated: boolean;
  }>;
}

export interface PurchaseOrderDetail extends PurchaseOrderSummary {
  supplier: { id: string; name: string; status: string; phone: string | null; email: string | null; contactName: string | null } | null;
  destination: { id: string; name: string; code: string; status: string };
  notes: string | null;
  shipping: number;
  otherCosts: number;
  tax: number;
  createdBy: string | null;
  lines: PurchaseOrderLineView[];
  receipts: PurchaseOrderReceiptView[];
}

export function formatPurchaseOrderNumber(number: number): string {
  return `PO${number}`;
}

// Correlated on the outer purchase order, qualified explicitly: drizzle
// renders a single-table select's columns without their table name.
const OUTER_PO_ID = sql.raw('"purchase_orders"."id"');
const lineAggregate = (expression: string) =>
  sql<number>`(SELECT COALESCE(${sql.raw(expression)}, 0) FROM ${purchaseOrderLines} AS po_line WHERE po_line.purchase_order_id = ${OUTER_PO_ID})`;
const lineTotalsSql = {
  lineCount: lineAggregate("count(*)"),
  quantity: lineAggregate("SUM(po_line.quantity)"),
  receivedQuantity: lineAggregate("SUM(po_line.received_quantity)"),
  subtotalMinor: lineAggregate("SUM(po_line.quantity * po_line.unit_cost_minor)"),
};

const headerFields = {
  id: purchaseOrders.id,
  number: purchaseOrders.number,
  status: purchaseOrders.status,
  supplierId: purchaseOrders.supplierId,
  // Joined columns get their own names: a batched select maps result
  // columns by name, and two `name` columns would collide.
  supplierName: sql<string | null>`${suppliers.name}`.as("po_supplier_name"),
  destinationId: purchaseOrders.destinationLocationId,
  destinationName: sql<string | null>`${inventoryLocations.name}`.as("po_destination_name"),
  expectedOn: purchaseOrders.expectedOn,
  reference: purchaseOrders.reference,
  currencyCode: purchaseOrders.currencyCode,
  shippingMinor: purchaseOrders.shippingMinor,
  otherCostsMinor: purchaseOrders.otherCostsMinor,
  taxMinor: purchaseOrders.taxMinor,
  revision: purchaseOrders.revision,
  orderedAt: purchaseOrders.orderedAt,
  receivedAt: purchaseOrders.receivedAt,
  cancelledAt: purchaseOrders.cancelledAt,
  createdAt: purchaseOrders.createdAt,
  updatedAt: purchaseOrders.updatedAt,
  ...lineTotalsSql,
};

type HeaderRow = {
  id: string; number: number; status: PurchaseOrderStatus; supplierId: string | null; supplierName: string | null;
  destinationId: string; destinationName: string | null; expectedOn: string | null; reference: string | null;
  currencyCode: string; shippingMinor: number; otherCostsMinor: number; taxMinor: number; revision: number;
  orderedAt: Date | null; receivedAt: Date | null; cancelledAt: Date | null; createdAt: Date; updatedAt: Date;
  lineCount: number; quantity: number; receivedQuantity: number; subtotalMinor: number;
};

function summaryFrom(row: HeaderRow): PurchaseOrderSummary {
  const decimals = getDecimalPlaces(row.currencyCode);
  const subtotalMinor = Number(row.subtotalMinor);
  return {
    id: row.id,
    number: row.number,
    displayNumber: formatPurchaseOrderNumber(row.number),
    status: row.status,
    supplier: row.supplierId ? { id: row.supplierId, name: row.supplierName ?? "" } : null,
    destination: { id: row.destinationId, name: row.destinationName ?? "" },
    expectedOn: row.expectedOn,
    reference: row.reference,
    currencyCode: row.currencyCode,
    lineCount: Number(row.lineCount),
    quantity: Number(row.quantity),
    receivedQuantity: Number(row.receivedQuantity),
    subtotal: fromMinor(subtotalMinor, decimals),
    total: fromMinor(subtotalMinor + row.shippingMinor + row.otherCostsMinor + row.taxMinor, decimals),
    revision: row.revision,
    orderedAt: row.orderedAt,
    receivedAt: row.receivedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `PO1001`, `#1001` or `1001` searches by number. */
function numberFromQuery(q: string): number | null {
  const match = /^#?\s*(?:po)?\s*-?\s*(\d{1,9})$/i.exec(q.trim());
  return match ? Number(match[1]) : null;
}

export async function listPurchaseOrders(db: Database, query: ListPurchaseOrdersQuery = {}) {
  const { q, status, supplierId, locationId, page, limit } = parse(listPurchaseOrdersQuerySchema, query);
  const conditions: SQL[] = [];
  if (status === "open") conditions.push(inArray(purchaseOrders.status, [...PURCHASE_ORDER_OPEN_STATUSES]));
  else if (status !== "all") conditions.push(eq(purchaseOrders.status, status));
  if (supplierId) conditions.push(eq(purchaseOrders.supplierId, supplierId));
  if (locationId) conditions.push(eq(purchaseOrders.destinationLocationId, locationId));
  if (q) {
    const number = numberFromQuery(q);
    const term = `%${q}%`;
    conditions.push(or(
      ...(number !== null ? [eq(purchaseOrders.number, number)] : []),
      like(purchaseOrders.reference, term),
      like(suppliers.name, term),
      sql`EXISTS (
        SELECT 1 FROM ${purchaseOrderLines} AS search_line
        JOIN ${productVariants} AS search_sku ON search_sku.id = search_line.variant_id
        WHERE search_line.purchase_order_id = ${OUTER_PO_ID}
          AND (search_sku.sku LIKE ${term} OR search_sku.barcode LIKE ${term})
      )`,
    )!);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [rows, counts] = await db.batch([
    db.select(headerFields)
      .from(purchaseOrders)
      .leftJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
      .leftJoin(inventoryLocations, eq(inventoryLocations.id, purchaseOrders.destinationLocationId))
      .where(where)
      .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.number))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: sql<number>`count(*)` })
      .from(purchaseOrders)
      .leftJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
      .where(where),
  ]);
  const total = Number(counts[0]?.total ?? 0);
  return {
    purchaseOrders: (rows as HeaderRow[]).map(summaryFrom),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getPurchaseOrder(db: Database, id: string): Promise<PurchaseOrderDetail> {
  const header = await db.select({
    ...headerFields,
    notes: purchaseOrders.notes,
    createdBy: purchaseOrders.createdBy,
    supplierStatus: sql<string | null>`${suppliers.status}`.as("po_supplier_status"),
    supplierPhone: sql<string | null>`${suppliers.phone}`.as("po_supplier_phone"),
    supplierEmail: sql<string | null>`${suppliers.email}`.as("po_supplier_email"),
    supplierContact: sql<string | null>`${suppliers.contactName}`.as("po_supplier_contact"),
    destinationCode: sql<string | null>`${inventoryLocations.code}`.as("po_destination_code"),
    destinationStatus: sql<string | null>`${inventoryLocations.status}`.as("po_destination_status"),
  })
    .from(purchaseOrders)
    .leftJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .leftJoin(inventoryLocations, eq(inventoryLocations.id, purchaseOrders.destinationLocationId))
    .where(eq(purchaseOrders.id, id))
    .get();
  if (!header) throw new NotFoundError("Purchase order not found");
  const decimals = getDecimalPlaces(header.currencyCode);
  const money = (minor: number) => fromMinor(minor, decimals);

  const [lineRows, receiptRows] = await db.batch([
    db.select({
      id: purchaseOrderLines.id,
      variantId: purchaseOrderLines.variantId,
      position: purchaseOrderLines.position,
      quantity: purchaseOrderLines.quantity,
      receivedQuantity: purchaseOrderLines.receivedQuantity,
      unitCostMinor: purchaseOrderLines.unitCostMinor,
      productId: productVariants.productId,
      productName: products.name,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      costMinor: productVariants.costMinor,
      deletedAt: productVariants.deletedAt,
      optionLabel: variantOptionLabelSql(productVariants.id),
    })
      .from(purchaseOrderLines)
      .innerJoin(productVariants, eq(productVariants.id, purchaseOrderLines.variantId))
      .leftJoin(products, eq(products.id, productVariants.productId))
      .where(eq(purchaseOrderLines.purchaseOrderId, id))
      .orderBy(asc(purchaseOrderLines.position), asc(purchaseOrderLines.id)),
    db.select({
      operationKey: purchaseOrderReceiptLines.operationKey,
      lineId: purchaseOrderReceiptLines.purchaseOrderLineId,
      variantId: purchaseOrderReceiptLines.variantId,
      sku: productVariants.sku,
      quantity: purchaseOrderReceiptLines.quantity,
      unitCostMinor: purchaseOrderReceiptLines.unitCostMinor,
      costBeforeMinor: purchaseOrderReceiptLines.costBeforeMinor,
      costAfterMinor: purchaseOrderReceiptLines.costAfterMinor,
      costUpdated: purchaseOrderReceiptLines.costUpdated,
      createdAt: inventoryCommands.createdAt,
      createdBy: inventoryCommands.createdBy,
      actorName: adminUsers.name,
    })
      .from(purchaseOrderReceiptLines)
      .innerJoin(inventoryCommands, eq(inventoryCommands.operationKey, purchaseOrderReceiptLines.operationKey))
      .innerJoin(productVariants, eq(productVariants.id, purchaseOrderReceiptLines.variantId))
      .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, purchaseOrderReceiptLines.purchaseOrderLineId))
      .leftJoin(adminUsers, eq(adminUsers.id, commandActorUserIdSql()))
      .where(eq(purchaseOrderReceiptLines.purchaseOrderId, id))
      .orderBy(asc(inventoryCommands.subjectRevision), asc(purchaseOrderLines.position), asc(purchaseOrderReceiptLines.id)),
  ]);

  const receipts: PurchaseOrderReceiptView[] = [];
  for (const row of receiptRows) {
    let receipt = receipts.find((candidate) => candidate.operationKey === row.operationKey);
    if (!receipt) {
      receipt = {
        operationKey: row.operationKey,
        createdAt: row.createdAt,
        actorName: row.createdBy ? row.actorName ?? "Former admin" : "System",
        lines: [],
      };
      receipts.push(receipt);
    }
    receipt.lines.push({
      lineId: row.lineId,
      variantId: row.variantId,
      sku: row.sku,
      quantity: row.quantity,
      unitCost: money(row.unitCostMinor),
      costBefore: row.costBeforeMinor === null ? null : money(row.costBeforeMinor),
      costAfter: row.costAfterMinor === null ? null : money(row.costAfterMinor),
      costUpdated: Boolean(row.costUpdated),
    });
  }

  const summary = summaryFrom(header as HeaderRow);
  return {
    ...summary,
    supplier: header.supplierId
      ? {
        id: header.supplierId,
        name: header.supplierName ?? "",
        status: header.supplierStatus ?? "active",
        phone: header.supplierPhone ?? null,
        email: header.supplierEmail ?? null,
        contactName: header.supplierContact ?? null,
      }
      : null,
    destination: {
      id: header.destinationId,
      name: header.destinationName ?? "",
      code: header.destinationCode ?? "",
      status: header.destinationStatus ?? "active",
    },
    notes: header.notes,
    shipping: money(header.shippingMinor),
    otherCosts: money(header.otherCostsMinor),
    tax: money(header.taxMinor),
    createdBy: header.createdBy,
    lines: lineRows.map((row) => ({
      id: row.id,
      variantId: row.variantId,
      productId: row.productId,
      productName: row.productName ?? null,
      sku: row.sku,
      barcode: row.barcode,
      optionLabel: row.optionLabel,
      retired: row.deletedAt !== null,
      position: row.position,
      quantity: row.quantity,
      receivedQuantity: row.receivedQuantity,
      openQuantity: row.quantity - row.receivedQuantity,
      unitCost: money(row.unitCostMinor),
      lineTotal: money(row.quantity * row.unitCostMinor),
      currentCost: row.costMinor === null ? null : money(row.costMinor),
    })),
    receipts,
  };
}

// ─────────────────────────────────────────
// Writes
// ─────────────────────────────────────────

type PlannedLine = { variantId: string; quantity: number; unitCostMinor: number };

/** Validates draft lines: live physical SKUs, each once, at most 100. */
async function planLines(
  db: Database,
  lines: ReadonlyArray<z.output<typeof purchaseOrderLineInputSchema>>,
  /** Costs are not prices: only the exponent matters. */
  currency: Pick<StoreCurrency, "code" | "decimalPlaces">,
): Promise<PlannedLine[]> {
  if (lines.length > PURCHASE_ORDER_MAX_LINES) {
    throw new ValidationError(`A purchase order holds at most ${PURCHASE_ORDER_MAX_LINES} SKUs.`);
  }
  if (new Set(lines.map((line) => line.variantId)).size !== lines.length) {
    throw new ValidationError("Each SKU appears once on a purchase order; change its quantity instead.");
  }
  const skus = await readStockCommandSkus(db, lines.map((line) => line.variantId));
  return lines.map((line, index) => {
    const sku = skus.get(line.variantId);
    if (!sku || sku.deletedAt) throw new ValidationError("A SKU on this purchase order no longer exists.");
    // A digital SKU's stock is its licence keys: it is never bought into stock.
    if (isDigitalKind(sku.fulfillmentKind)) {
      throw digitalStockError({ field: `lines.${index}.variantId`, sku: sku.sku, variantId: sku.id });
    }
    if (sku.fulfillmentKind !== "physical") {
      throw new ValidationError(`SKU ${sku.sku} is not a physical item, so it is not bought into stock.`);
    }
    return { variantId: line.variantId, quantity: line.quantity, unitCostMinor: unitCostToMinor(line.unitCost, currency) };
  });
}

function lineInserts(db: Database, purchaseOrderId: string, lines: readonly PlannedLine[]): BatchItem<"sqlite">[] {
  const rows = lines.map((line, position) => ({
    id: `pol_${nanoid(16)}`,
    purchaseOrderId,
    variantId: line.variantId,
    position,
    quantity: line.quantity,
    receivedQuantity: 0,
    unitCostMinor: line.unitCostMinor,
    createdAt: sql`unixepoch()`,
    updatedAt: sql`unixepoch()`,
  }));
  return chunkRowsForD1(rows, 9).map((chunk) => db.insert(purchaseOrderLines).values(chunk) as unknown as BatchItem<"sqlite">);
}

function subjectGuard(db: Database, id: string, revision: number, statuses: readonly PurchaseOrderStatus[]): BatchItem<"sqlite"> {
  return buildBatchGuard(db, sql`EXISTS (
    SELECT 1 FROM ${purchaseOrders}
    WHERE ${purchaseOrders.id} = ${id}
      AND ${purchaseOrders.revision} = ${revision}
      AND ${purchaseOrders.status} IN (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})
  )`, STALE);
}

async function readHeader(db: Database, id: string) {
  const row = await db.select({
    id: purchaseOrders.id,
    number: purchaseOrders.number,
    status: purchaseOrders.status,
    revision: purchaseOrders.revision,
    destinationLocationId: purchaseOrders.destinationLocationId,
    supplierId: purchaseOrders.supplierId,
    currencyCode: purchaseOrders.currencyCode,
  }).from(purchaseOrders).where(eq(purchaseOrders.id, id)).get();
  if (!row) throw new NotFoundError("Purchase order not found");
  return row;
}

const STATUS_WORDS: Record<PurchaseOrderStatus, string> = {
  draft: "a draft",
  ordered: "ordered",
  partially_received: "partially received",
  received: "received",
  cancelled: "cancelled",
};

function assertStatus(
  header: { number: number; status: PurchaseOrderStatus },
  allowed: readonly PurchaseOrderStatus[],
  action: string,
): void {
  if (!allowed.includes(header.status)) {
    throw new ConflictError(`${formatPurchaseOrderNumber(header.number)} is ${STATUS_WORDS[header.status]}, so it can't be ${action}.`);
  }
}

function assertRevision(header: { revision: number }, expected: number): void {
  if (header.revision !== expected) throw new ConflictError("This purchase order changed. Reload to see the latest.");
}

function textOrNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value ? value : null;
}

async function runGuarded(db: Database, statements: BatchItem<"sqlite">[]): Promise<void> {
  try {
    await safeBatch(db, statements as never);
  } catch (error) {
    if (isBatchGuardError(error, STALE)) throw new ConflictError("This purchase order changed. Reload to see the latest.");
    if (/PURCHASE_ORDER_LINES_LOCKED/.test(String((error as Error)?.message ?? "") + String((error as { cause?: Error })?.cause?.message ?? ""))) {
      throw new ConflictError("An ordered purchase order's lines can't change.");
    }
    throw error;
  }
}

function isNumberConflict(error: unknown): boolean {
  const text = String((error as Error)?.message ?? "") + String((error as { cause?: Error })?.cause?.message ?? "");
  return /purchase_orders_number_unique|purchase_orders\.number/i.test(text);
}

export async function createPurchaseOrder(
  db: Database,
  input: CreatePurchaseOrderInput,
  actorId?: string | null,
): Promise<PurchaseOrderDetail> {
  const data = parse(createPurchaseOrderSchema, input);
  const currency = await readStoreCurrency(db);
  const destination = await resolveActiveInventoryLocation(db, data.destinationLocationId);
  if (data.supplierId) await assertActiveSupplier(db, data.supplierId);
  const lines = await planLines(db, data.lines ?? [], currency);
  const id = `po_${nanoid(16)}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await safeBatch(db, [
        db.insert(purchaseOrders).values({
          id,
          number: sql`(SELECT COALESCE(MAX(${purchaseOrders.number}), ${NUMBER_START}) + 1 FROM ${purchaseOrders})`,
          supplierId: data.supplierId ?? null,
          destinationLocationId: destination.id,
          status: "draft",
          expectedOn: data.expectedOn ?? null,
          reference: textOrNull(data.reference) ?? null,
          notes: textOrNull(data.notes) ?? null,
          currencyCode: currency.code,
          shippingMinor: unitCostToMinor(data.shipping ?? 0, currency),
          otherCostsMinor: unitCostToMinor(data.otherCosts ?? 0, currency),
          taxMinor: unitCostToMinor(data.tax ?? 0, currency),
          revision: 1,
          createdBy: actorId ?? null,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        }),
        ...lineInserts(db, id, lines),
      ] as never);
      break;
    } catch (error) {
      // Two drafts created at once drew the same number: draw again.
      if (attempt < 3 && isNumberConflict(error)) continue;
      throw error;
    }
  }
  return getPurchaseOrder(db, id);
}

/**
 * Edits a purchase order at the revision the merchant saw. A draft takes any
 * change, lines included (they are replaced); once ordered only the
 * supplier, expected date, reference, notes and the cost totals change.
 */
export async function updatePurchaseOrder(
  db: Database,
  id: string,
  input: UpdatePurchaseOrderInput,
): Promise<PurchaseOrderDetail> {
  const data = parse(updatePurchaseOrderSchema, input);
  const header = await readHeader(db, id);
  assertRevision(header, data.expectedRevision);
  assertStatus(header, ["draft", "ordered", "partially_received"], "edited");
  const isDraft = header.status === "draft";
  if (!isDraft && data.lines !== undefined) throw new ConflictError("An ordered purchase order's lines can't change.");
  if (!isDraft && data.destinationLocationId !== undefined && data.destinationLocationId !== header.destinationLocationId) {
    throw new ConflictError("An ordered purchase order's destination can't change.");
  }
  const currency = { code: header.currencyCode, decimalPlaces: getDecimalPlaces(header.currencyCode) };
  const destination = data.destinationLocationId !== undefined && data.destinationLocationId !== header.destinationLocationId
    ? await resolveActiveInventoryLocation(db, data.destinationLocationId)
    : null;
  if (data.supplierId && data.supplierId !== header.supplierId) await assertActiveSupplier(db, data.supplierId);
  const lines = data.lines !== undefined ? await planLines(db, data.lines, currency) : null;

  await runGuarded(db, [
    subjectGuard(db, id, data.expectedRevision, isDraft ? ["draft"] : ["ordered", "partially_received"]),
    db.update(purchaseOrders).set({
      ...(data.supplierId !== undefined ? { supplierId: data.supplierId } : {}),
      ...(destination ? { destinationLocationId: destination.id } : {}),
      ...(data.expectedOn !== undefined ? { expectedOn: data.expectedOn } : {}),
      ...(data.reference !== undefined ? { reference: textOrNull(data.reference) } : {}),
      ...(data.notes !== undefined ? { notes: textOrNull(data.notes) } : {}),
      ...(data.shipping !== undefined ? { shippingMinor: unitCostToMinor(data.shipping, currency) } : {}),
      ...(data.otherCosts !== undefined ? { otherCostsMinor: unitCostToMinor(data.otherCosts, currency) } : {}),
      ...(data.tax !== undefined ? { taxMinor: unitCostToMinor(data.tax, currency) } : {}),
      revision: sql`${purchaseOrders.revision} + 1`,
      updatedAt: sql`unixepoch()`,
    }).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.revision, data.expectedRevision))),
    ...(lines
      ? [db.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id)), ...lineInserts(db, id, lines)]
      : []),
  ]);
  return getPurchaseOrder(db, id);
}

/** Draft → ordered: its lines become incoming stock at the destination. */
export async function markPurchaseOrderOrdered(db: Database, id: string, expectedRevision: number): Promise<PurchaseOrderDetail> {
  const header = await readHeader(db, id);
  if (header.status === "ordered" && header.revision === expectedRevision + 1) return getPurchaseOrder(db, id);
  assertRevision(header, expectedRevision);
  assertStatus(header, ["draft"], "marked as ordered");
  await resolveActiveInventoryLocation(db, header.destinationLocationId);
  const lineCount = await db.select({ n: sql<number>`count(*)` }).from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, id)).get();
  if (Number(lineCount?.n ?? 0) === 0) throw new ValidationError("Add at least one product before ordering.");
  await runGuarded(db, [
    subjectGuard(db, id, expectedRevision, ["draft"]),
    db.update(purchaseOrders).set({
      status: "ordered",
      orderedAt: sql`unixepoch()`,
      revision: sql`${purchaseOrders.revision} + 1`,
      updatedAt: sql`unixepoch()`,
    }).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.revision, expectedRevision))),
  ]);
  return getPurchaseOrder(db, id);
}

/** Stops the rest of an order coming (received units stay in stock). */
export async function cancelPurchaseOrder(db: Database, id: string, expectedRevision: number): Promise<PurchaseOrderDetail> {
  const header = await readHeader(db, id);
  if (header.status === "cancelled") return getPurchaseOrder(db, id);
  assertRevision(header, expectedRevision);
  assertStatus(header, ["draft", "ordered", "partially_received"], "cancelled");
  await runGuarded(db, [
    subjectGuard(db, id, expectedRevision, ["draft", "ordered", "partially_received"]),
    db.update(purchaseOrders).set({
      status: "cancelled",
      cancelledAt: sql`unixepoch()`,
      revision: sql`${purchaseOrders.revision} + 1`,
      updatedAt: sql`unixepoch()`,
    }).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.revision, expectedRevision))),
  ]);
  return getPurchaseOrder(db, id);
}

/** Deletes a draft (an ordered PO is cancelled instead, keeping its history). */
export async function deletePurchaseOrder(db: Database, id: string, expectedRevision: number): Promise<{ id: string; deleted: true }> {
  const header = await readHeader(db, id);
  assertRevision(header, expectedRevision);
  assertStatus(header, ["draft"], "deleted (cancel it instead)");
  await runGuarded(db, [
    subjectGuard(db, id, expectedRevision, ["draft"]),
    db.delete(purchaseOrders).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.revision, expectedRevision))),
  ]);
  return { id, deleted: true };
}

// ─────────────────────────────────────────
// Receiving
// ─────────────────────────────────────────

/** Stored with the operation key (minor units) and replayed on an exact retry. */
interface StoredPurchaseOrderReceipt {
  purchaseOrderId: string;
  number: number;
  status: PurchaseOrderStatus;
  revision: number;
  locationId: string;
  currencyCode: string;
  costUpdated: boolean;
  lines: Array<{
    lineId: string;
    variantId: string;
    sku: string;
    quantity: number;
    movementId: string;
    unitCostMinor: number;
    costBeforeMinor: number | null;
    costAfterMinor: number | null;
    stockAfter: number;
  }>;
}

export interface PurchaseOrderReceiptResult {
  purchaseOrderId: string;
  displayNumber: string;
  status: PurchaseOrderStatus;
  revision: number;
  locationId: string;
  costUpdated: boolean;
  lines: Array<{
    lineId: string;
    variantId: string;
    sku: string;
    quantity: number;
    movementId: string;
    unitCost: number;
    costBefore: number | null;
    costAfter: number | null;
    stockAfter: number;
  }>;
}

function presentReceipt(stored: StoredPurchaseOrderReceipt): PurchaseOrderReceiptResult {
  const decimals = getDecimalPlaces(stored.currencyCode);
  const money = (minor: number | null) => (minor === null ? null : fromMinor(minor, decimals));
  return {
    purchaseOrderId: stored.purchaseOrderId,
    displayNumber: formatPurchaseOrderNumber(stored.number),
    status: stored.status,
    revision: stored.revision,
    locationId: stored.locationId,
    costUpdated: stored.costUpdated,
    lines: stored.lines.map((line) => ({
      lineId: line.lineId,
      variantId: line.variantId,
      sku: line.sku,
      quantity: line.quantity,
      movementId: line.movementId,
      unitCost: fromMinor(line.unitCostMinor, decimals),
      costBefore: money(line.costBeforeMinor),
      costAfter: money(line.costAfterMinor),
      stockAfter: line.stockAfter,
    })),
  };
}

/**
 * Receives some or all of an ordered purchase order's open quantities at its
 * destination: one `received` movement per SKU with its stockVersion CAS,
 * the receipt lines (cost history), line progress and the PO's new status,
 * all in one batch under the merchant's operation key.
 */
export async function receivePurchaseOrder(
  db: Database,
  id: string,
  input: ReceivePurchaseOrderInput,
  actorId?: string | null,
): Promise<PurchaseOrderReceiptResult> {
  const data = parse(receivePurchaseOrderSchema, input, "Invalid receipt");
  if (new Set(data.lines.map((line) => line.lineId)).size !== data.lines.length) {
    throw new ValidationError("Each purchase order line appears once in a receipt.");
  }
  const request = {
    lines: [...data.lines].sort((left, right) => left.lineId.localeCompare(right.lineId)),
    updateCost: data.updateCost,
  };
  const stored = await executeStockCommand<StoredPurchaseOrderReceipt>(db, {
    operationKey: data.operationKey,
    commandType: "purchase_order_receive",
    subjectId: id,
    request,
    createdBy: actorId ?? null,
    plan: async () => {
      const header = await readHeader(db, id);
      assertStatus(header, PURCHASE_ORDER_OPEN_STATUSES, "received");
      const location = await resolveActiveInventoryLocation(db, header.destinationLocationId);
      const lines = await db.select({
        id: purchaseOrderLines.id,
        variantId: purchaseOrderLines.variantId,
        quantity: purchaseOrderLines.quantity,
        receivedQuantity: purchaseOrderLines.receivedQuantity,
        unitCostMinor: purchaseOrderLines.unitCostMinor,
      }).from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id)).all();
      const byId = new Map(lines.map((line) => [line.id, line]));
      const label = formatPurchaseOrderNumber(header.number);
      const planned = data.lines.map((requested) => {
        const line = byId.get(requested.lineId);
        if (!line) throw new NotFoundError("A line in this receipt is not on the purchase order.");
        const open = line.quantity - line.receivedQuantity;
        if (requested.quantity > open) {
          throw new ConflictError(open === 0
            ? "A line in this receipt is already fully received."
            : `Only ${open} of a line are still to receive.`);
        }
        return { line, quantity: requested.quantity };
      });
      const receivedNow = new Map(planned.map((entry) => [entry.line.id, entry.quantity]));
      const fullyReceived = lines.every((line) => line.receivedQuantity + (receivedNow.get(line.id) ?? 0) === line.quantity);
      const status: PurchaseOrderStatus = fullyReceived ? "received" : "partially_received";
      const lineByVariant = new Map(planned.map((entry) => [entry.line.variantId, entry]));
      return {
        lines: planned.map((entry) => ({
          variantId: entry.line.variantId,
          location,
          type: "received" as const,
          quantity: entry.quantity,
          notes: `Received on purchase order ${label}`,
          ...(data.updateCost ? { averageCostAtMinor: entry.line.unitCostMinor } : {}),
        })),
        subjectGuard: sql`EXISTS (
          SELECT 1 FROM ${purchaseOrders}
          WHERE ${purchaseOrders.id} = ${id}
            AND ${purchaseOrders.revision} = ${header.revision}
            AND ${purchaseOrders.status} IN ('ordered', 'partially_received')
        )`,
        subjectRevisionAfter: header.revision + 1,
        documentStatements: (edges: readonly StockCommandEdge[]) => [
          // One statement for every line's progress and multi-row receipt
          // inserts: a 100-line receipt stays near two statements per SKU.
          db.update(purchaseOrderLines).set({
            receivedQuantity: sql`${purchaseOrderLines.receivedQuantity} + ${addedQuantitySql(
              planned.map((entry) => ({ id: entry.line.id, quantity: entry.quantity })),
              "purchase_order_lines",
            )}`,
            updatedAt: sql`unixepoch()`,
          }).where(sql`${purchaseOrderLines.id} IN (${idsFromJsonSql(planned.map((entry) => entry.line.id))})`) as unknown as BatchItem<"sqlite">,
          ...chunkRowsForD1(edges.map((edge) => {
            const entry = lineByVariant.get(edge.before.id)!;
            return {
              id: `porl_${edge.movementId.slice(5, 37)}`,
              operationKey: data.operationKey.trim(),
              purchaseOrderId: id,
              purchaseOrderLineId: entry.line.id,
              variantId: edge.before.id,
              locationId: location.id,
              movementId: edge.movementId,
              quantity: entry.quantity,
              unitCostMinor: entry.line.unitCostMinor,
              costBeforeMinor: edge.before.costMinor,
              costAfterMinor: edge.costAfterMinor,
              costUpdated: data.updateCost,
              createdBy: actorId ?? null,
              createdAt: sql`unixepoch()`,
            };
          }), 14).map((rows) => db.insert(purchaseOrderReceiptLines).values(rows) as unknown as BatchItem<"sqlite">),
          db.update(purchaseOrders).set({
            status,
            ...(fullyReceived ? { receivedAt: sql`unixepoch()` } : {}),
            revision: sql`${purchaseOrders.revision} + 1`,
            updatedAt: sql`unixepoch()`,
          }).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.revision, header.revision))) as unknown as BatchItem<"sqlite">,
        ],
        result: (edges: readonly StockCommandEdge[]): StoredPurchaseOrderReceipt => ({
          purchaseOrderId: id,
          number: header.number,
          status,
          revision: header.revision + 1,
          locationId: location.id,
          currencyCode: header.currencyCode,
          costUpdated: data.updateCost,
          lines: edges.map((edge) => {
            const entry = lineByVariant.get(edge.before.id)!;
            return {
              lineId: entry.line.id,
              variantId: edge.before.id,
              sku: edge.before.sku,
              quantity: entry.quantity,
              movementId: edge.movementId,
              unitCostMinor: entry.line.unitCostMinor,
              costBeforeMinor: edge.before.costMinor,
              costAfterMinor: edge.costAfterMinor,
              stockAfter: edge.stockAfter,
            };
          }),
        }),
      };
    },
  });
  return presentReceipt(stored);
}

// ─────────────────────────────────────────
// Export
// ─────────────────────────────────────────

/** One purchase order as CSV: a header block, then one row per line (formula-safe). */
export async function buildPurchaseOrderCsv(db: Database, id: string) {
  const order = await getPurchaseOrder(db, id);
  const rows: unknown[][] = [
    ["Purchase order", order.displayNumber],
    ["Status", order.status],
    ["Supplier", order.supplier?.name ?? ""],
    ["Destination", order.destination.name],
    ["Expected", order.expectedOn ?? ""],
    ["Reference", order.reference ?? ""],
    ["Currency", order.currencyCode],
    [],
    ["SKU", "Product", "Variant", "Barcode", "Quantity", "Received", "Open", "Unit cost", "Line total"],
    ...order.lines.map((line) => [
      line.sku, line.productName, line.optionLabel, line.barcode, line.quantity,
      line.receivedQuantity, line.openQuantity, line.unitCost, line.lineTotal,
    ]),
    [],
    ["Subtotal", order.subtotal],
    ["Shipping", order.shipping],
    ["Other costs", order.otherCosts],
    ["Tax", order.tax],
    ["Total", order.total],
  ];
  const body = `\uFEFF${rows.map((row) => row.map(spreadsheetSafeCsvCell).join(",")).join("\n")}\n`;
  return {
    body,
    byteLength: new TextEncoder().encode(body).byteLength,
    filename: `purchase-order-${order.displayNumber}.csv`,
    contentType: "text/csv; charset=utf-8" as const,
  };
}
