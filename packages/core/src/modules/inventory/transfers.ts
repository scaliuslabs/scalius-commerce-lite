// Transfers between locations (migration 0109): draft → in transit →
// partially received → received, or cancelled.
//
// Shipping takes every line out of the origin at once (`transfer_out`
// movements). Units in transit are out of the origin level AND out of the
// SKU's stock, so buyer availability (stock − reserved) never counts them
// and sum(levels) = stock holds throughout. Receiving books them at the
// destination (`transfer_in`), in parts if need be; cancelling returns
// whatever is still in transit to the origin (`transfer_in` there). A
// shipment that would take units the origin does not hold, or units
// committed to orders, is refused before anything is written. Every write
// advances `revision` exactly once (one event each).

import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { containsText } from "../../utils/text-match";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { BatchItem } from "drizzle-orm/batch";
import { alias } from "drizzle-orm/sqlite-core";
import { buildBatchGuard, chunkRowsForD1, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import {
  inventoryCommands,
  inventoryLocations,
  inventoryTransferLines,
  inventoryTransferMovements,
  inventoryTransfers,
  productVariants,
  products,
  user as adminUsers,
  INVENTORY_TRANSFER_STATUSES,
  type InventoryTransferMovementKind,
  type InventoryTransferStatus,
} from "@scalius/database/schema";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { digitalStockError, isDigitalKind, variantOptionLabelSql } from "../products";
import { inventoryOperationKeySchema } from "./inventory.validation";
import { resolveActiveInventoryLocation, type InventoryLocationRef } from "./locations";
import { addedQuantitySql, commandActorUserIdSql, executeStockCommand, idsFromJsonSql, readStockCommandSkus, type StockCommandEdge } from "./stock-commands";

export const INVENTORY_TRANSFER_MAX_LINES = 100;
export const INVENTORY_TRANSFER_OPEN_STATUSES = ["in_transit", "partially_received"] as const satisfies readonly InventoryTransferStatus[];
const STALE = "INVENTORY_TRANSFER_STALE";
const NUMBER_START = 1000;

const dateOnlySchema = z.string().trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), "Use a real calendar date.");
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const locationIdSchema = z.string().trim().min(1).max(100);

export const transferLineInputSchema = z.object({
  variantId: z.string().trim().min(1).max(100),
  quantity: z.number().int().min(1).max(1_000_000),
});

export const createTransferSchema = z.object({
  originLocationId: locationIdSchema,
  destinationLocationId: locationIdSchema,
  expectedOn: dateOnlySchema.nullable().optional(),
  reference: optionalText(100),
  notes: optionalText(2000),
  lines: z.array(transferLineInputSchema).max(INVENTORY_TRANSFER_MAX_LINES).optional(),
});
export type CreateTransferInput = z.input<typeof createTransferSchema>;

export const updateTransferSchema = z.object({
  originLocationId: locationIdSchema.optional(),
  destinationLocationId: locationIdSchema.optional(),
  expectedOn: dateOnlySchema.nullable().optional(),
  reference: optionalText(100),
  notes: optionalText(2000),
  /** Replaces every line (drafts only). Omit to keep them. */
  lines: z.array(transferLineInputSchema).max(INVENTORY_TRANSFER_MAX_LINES).optional(),
  expectedRevision: z.number().int().min(1),
});
export type UpdateTransferInput = z.input<typeof updateTransferSchema>;

export const shipTransferSchema = z.object({
  operationKey: inventoryOperationKeySchema,
  expectedRevision: z.number().int().min(1),
});
export type ShipTransferInput = z.input<typeof shipTransferSchema>;

export const receiveTransferSchema = z.object({
  operationKey: inventoryOperationKeySchema,
  lines: z.array(z.object({
    lineId: z.string().trim().min(1).max(100),
    quantity: z.number().int().min(1).max(1_000_000),
  })).min(1).max(INVENTORY_TRANSFER_MAX_LINES),
});
export type ReceiveTransferInput = z.input<typeof receiveTransferSchema>;

export const cancelTransferSchema = z.object({
  operationKey: inventoryOperationKeySchema,
  expectedRevision: z.number().int().min(1),
});
export type CancelTransferInput = z.input<typeof cancelTransferSchema>;

export const listTransfersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum([...INVENTORY_TRANSFER_STATUSES, "open", "all"]).optional().default("all"),
  locationId: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});
export type ListTransfersQuery = z.input<typeof listTransfersQuerySchema>;

function parse<T>(schema: z.ZodType<T>, input: unknown, fallback = "Invalid transfer"): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}

export function formatTransferNumber(number: number): string {
  return `T${number}`;
}

// ─────────────────────────────────────────
// Read models
// ─────────────────────────────────────────

export interface TransferSummary {
  id: string;
  number: number;
  displayNumber: string;
  status: InventoryTransferStatus;
  origin: { id: string; name: string };
  destination: { id: string; name: string };
  expectedOn: string | null;
  reference: string | null;
  lineCount: number;
  quantity: number;
  receivedQuantity: number;
  returnedQuantity: number;
  /** Shipped but not yet received or returned. */
  inTransitQuantity: number;
  revision: number;
  shippedAt: Date | null;
  receivedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TransferLineView {
  id: string;
  variantId: string;
  productId: string;
  productName: string | null;
  sku: string;
  barcode: string | null;
  optionLabel: string | null;
  retired: boolean;
  position: number;
  quantity: number;
  shippedQuantity: number;
  receivedQuantity: number;
  returnedQuantity: number;
  inTransitQuantity: number;
}

export interface TransferActivityView {
  operationKey: string;
  kind: InventoryTransferMovementKind;
  createdAt: Date;
  actorName: string;
  lines: Array<{ lineId: string; variantId: string; sku: string; quantity: number; locationId: string }>;
}

export interface TransferDetail extends TransferSummary {
  origin: { id: string; name: string; code: string; status: string };
  destination: { id: string; name: string; code: string; status: string };
  notes: string | null;
  createdBy: string | null;
  lines: TransferLineView[];
  activity: TransferActivityView[];
}

const originLocations = alias(inventoryLocations, "origin_location");
const destinationLocations = alias(inventoryLocations, "destination_location");

// Correlated on the outer transfer, qualified explicitly: drizzle renders a
// single-table select's columns without their table name.
const OUTER_TRANSFER_ID = sql.raw('"inventory_transfers"."id"');
const lineAggregate = (expression: string) =>
  sql<number>`(SELECT COALESCE(${sql.raw(expression)}, 0) FROM ${inventoryTransferLines} AS transfer_line WHERE transfer_line.transfer_id = ${OUTER_TRANSFER_ID})`;

const headerFields = {
  id: inventoryTransfers.id,
  number: inventoryTransfers.number,
  status: inventoryTransfers.status,
  originId: inventoryTransfers.originLocationId,
  // Joined columns get their own names: a batched select maps result
  // columns by name, and the two locations' `name` would collide.
  originName: sql<string | null>`${originLocations.name}`.as("transfer_origin_name"),
  destinationId: inventoryTransfers.destinationLocationId,
  destinationName: sql<string | null>`${destinationLocations.name}`.as("transfer_destination_name"),
  expectedOn: inventoryTransfers.expectedOn,
  reference: inventoryTransfers.reference,
  revision: inventoryTransfers.revision,
  shippedAt: inventoryTransfers.shippedAt,
  receivedAt: inventoryTransfers.receivedAt,
  cancelledAt: inventoryTransfers.cancelledAt,
  createdAt: inventoryTransfers.createdAt,
  updatedAt: inventoryTransfers.updatedAt,
  lineCount: lineAggregate("count(*)"),
  quantity: lineAggregate("SUM(transfer_line.quantity)"),
  shippedQuantity: lineAggregate("SUM(transfer_line.shipped_quantity)"),
  receivedQuantity: lineAggregate("SUM(transfer_line.received_quantity)"),
  returnedQuantity: lineAggregate("SUM(transfer_line.returned_quantity)"),
};

type HeaderRow = {
  id: string; number: number; status: InventoryTransferStatus; originId: string; originName: string | null;
  destinationId: string; destinationName: string | null; expectedOn: string | null; reference: string | null;
  revision: number; shippedAt: Date | null; receivedAt: Date | null; cancelledAt: Date | null;
  createdAt: Date; updatedAt: Date; lineCount: number; quantity: number; shippedQuantity: number;
  receivedQuantity: number; returnedQuantity: number;
};

function summaryFrom(row: HeaderRow): TransferSummary {
  const shipped = Number(row.shippedQuantity);
  const received = Number(row.receivedQuantity);
  const returned = Number(row.returnedQuantity);
  return {
    id: row.id,
    number: row.number,
    displayNumber: formatTransferNumber(row.number),
    status: row.status,
    origin: { id: row.originId, name: row.originName ?? "" },
    destination: { id: row.destinationId, name: row.destinationName ?? "" },
    expectedOn: row.expectedOn,
    reference: row.reference,
    lineCount: Number(row.lineCount),
    quantity: Number(row.quantity),
    receivedQuantity: received,
    returnedQuantity: returned,
    inTransitQuantity: shipped - received - returned,
    revision: row.revision,
    shippedAt: row.shippedAt,
    receivedAt: row.receivedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function numberFromQuery(q: string): number | null {
  const match = /^#?\s*t?\s*-?\s*(\d{1,9})$/i.exec(q.trim());
  return match ? Number(match[1]) : null;
}

function headerQuery(db: Database) {
  return db.select(headerFields)
    .from(inventoryTransfers)
    .leftJoin(originLocations, eq(originLocations.id, inventoryTransfers.originLocationId))
    .leftJoin(destinationLocations, eq(destinationLocations.id, inventoryTransfers.destinationLocationId));
}

export async function listTransfers(db: Database, query: ListTransfersQuery = {}) {
  const { q, status, locationId, page, limit } = parse(listTransfersQuerySchema, query);
  const conditions: SQL[] = [];
  if (status === "open") conditions.push(inArray(inventoryTransfers.status, [...INVENTORY_TRANSFER_OPEN_STATUSES]));
  else if (status !== "all") conditions.push(eq(inventoryTransfers.status, status));
  if (locationId) {
    conditions.push(or(eq(inventoryTransfers.originLocationId, locationId), eq(inventoryTransfers.destinationLocationId, locationId))!);
  }
  if (q) {
    const number = numberFromQuery(q);
    conditions.push(or(
      ...(number !== null ? [eq(inventoryTransfers.number, number)] : []),
      containsText(inventoryTransfers.reference, q),
      sql`EXISTS (
        SELECT 1 FROM ${inventoryTransferLines} AS search_line
        JOIN ${productVariants} AS search_sku ON search_sku.id = search_line.variant_id
        WHERE search_line.transfer_id = ${OUTER_TRANSFER_ID}
          AND (${containsText(sql`search_sku.sku`, q)} OR ${containsText(sql`search_sku.barcode`, q)})
      )`,
    )!);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [rows, counts] = await db.batch([
    headerQuery(db).where(where)
      .orderBy(desc(inventoryTransfers.createdAt), desc(inventoryTransfers.number))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: sql<number>`count(*)` }).from(inventoryTransfers).where(where),
  ]);
  const total = Number(counts[0]?.total ?? 0);
  return {
    transfers: (rows as HeaderRow[]).map(summaryFrom),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getTransfer(db: Database, id: string): Promise<TransferDetail> {
  const header = await db.select({
    ...headerFields,
    notes: inventoryTransfers.notes,
    createdBy: inventoryTransfers.createdBy,
    originCode: sql<string | null>`${originLocations.code}`.as("transfer_origin_code"),
    originStatus: sql<string | null>`${originLocations.status}`.as("transfer_origin_status"),
    destinationCode: sql<string | null>`${destinationLocations.code}`.as("transfer_destination_code"),
    destinationStatus: sql<string | null>`${destinationLocations.status}`.as("transfer_destination_status"),
  })
    .from(inventoryTransfers)
    .leftJoin(originLocations, eq(originLocations.id, inventoryTransfers.originLocationId))
    .leftJoin(destinationLocations, eq(destinationLocations.id, inventoryTransfers.destinationLocationId))
    .where(eq(inventoryTransfers.id, id))
    .get();
  if (!header) throw new NotFoundError("Transfer not found");
  const [lineRows, activityRows] = await db.batch([
    db.select({
      id: inventoryTransferLines.id,
      variantId: inventoryTransferLines.variantId,
      position: inventoryTransferLines.position,
      quantity: inventoryTransferLines.quantity,
      shippedQuantity: inventoryTransferLines.shippedQuantity,
      receivedQuantity: inventoryTransferLines.receivedQuantity,
      returnedQuantity: inventoryTransferLines.returnedQuantity,
      productId: productVariants.productId,
      productName: products.name,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      deletedAt: productVariants.deletedAt,
      optionLabel: variantOptionLabelSql(productVariants.id),
    })
      .from(inventoryTransferLines)
      .innerJoin(productVariants, eq(productVariants.id, inventoryTransferLines.variantId))
      .leftJoin(products, eq(products.id, productVariants.productId))
      .where(eq(inventoryTransferLines.transferId, id))
      .orderBy(asc(inventoryTransferLines.position), asc(inventoryTransferLines.id)),
    db.select({
      operationKey: inventoryTransferMovements.operationKey,
      kind: inventoryTransferMovements.kind,
      lineId: inventoryTransferMovements.transferLineId,
      variantId: inventoryTransferMovements.variantId,
      sku: productVariants.sku,
      quantity: inventoryTransferMovements.quantity,
      locationId: inventoryTransferMovements.locationId,
      createdAt: inventoryCommands.createdAt,
      createdBy: inventoryCommands.createdBy,
      actorName: adminUsers.name,
    })
      .from(inventoryTransferMovements)
      .innerJoin(inventoryCommands, eq(inventoryCommands.operationKey, inventoryTransferMovements.operationKey))
      .innerJoin(productVariants, eq(productVariants.id, inventoryTransferMovements.variantId))
      .innerJoin(inventoryTransferLines, eq(inventoryTransferLines.id, inventoryTransferMovements.transferLineId))
      .leftJoin(adminUsers, eq(adminUsers.id, commandActorUserIdSql()))
      .where(eq(inventoryTransferMovements.transferId, id))
      .orderBy(asc(inventoryCommands.subjectRevision), asc(inventoryTransferLines.position), asc(inventoryTransferMovements.id)),
  ]);
  const activity: TransferActivityView[] = [];
  for (const row of activityRows) {
    let entry = activity.find((candidate) => candidate.operationKey === row.operationKey);
    if (!entry) {
      entry = {
        operationKey: row.operationKey,
        kind: row.kind,
        createdAt: row.createdAt,
        actorName: row.createdBy ? row.actorName ?? "Former admin" : "System",
        lines: [],
      };
      activity.push(entry);
    }
    entry.lines.push({ lineId: row.lineId, variantId: row.variantId, sku: row.sku, quantity: row.quantity, locationId: row.locationId });
  }
  return {
    ...summaryFrom(header as HeaderRow),
    origin: { id: header.originId, name: header.originName ?? "", code: header.originCode ?? "", status: header.originStatus ?? "active" },
    destination: {
      id: header.destinationId,
      name: header.destinationName ?? "",
      code: header.destinationCode ?? "",
      status: header.destinationStatus ?? "active",
    },
    notes: header.notes,
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
      shippedQuantity: row.shippedQuantity,
      receivedQuantity: row.receivedQuantity,
      returnedQuantity: row.returnedQuantity,
      inTransitQuantity: row.shippedQuantity - row.receivedQuantity - row.returnedQuantity,
    })),
    activity,
  };
}

// ─────────────────────────────────────────
// Draft writes
// ─────────────────────────────────────────

type PlannedLine = { variantId: string; quantity: number };

async function planLines(db: Database, lines: ReadonlyArray<PlannedLine>): Promise<PlannedLine[]> {
  if (lines.length > INVENTORY_TRANSFER_MAX_LINES) {
    throw new ValidationError(`A transfer holds at most ${INVENTORY_TRANSFER_MAX_LINES} SKUs.`);
  }
  if (new Set(lines.map((line) => line.variantId)).size !== lines.length) {
    throw new ValidationError("Each SKU appears once on a transfer; change its quantity instead.");
  }
  const skus = await readStockCommandSkus(db, lines.map((line) => line.variantId));
  for (const [index, line] of lines.entries()) {
    const sku = skus.get(line.variantId);
    if (!sku || sku.deletedAt) throw new ValidationError("A SKU on this transfer no longer exists.");
    // A digital SKU's stock is its licence keys: it isn't held at a location to move.
    if (isDigitalKind(sku.fulfillmentKind)) {
      throw digitalStockError({ field: `lines.${index}.variantId`, sku: sku.sku, variantId: sku.id });
    }
    if (sku.fulfillmentKind !== "physical") {
      throw new ValidationError(`SKU ${sku.sku} is not a physical item, so it has no stock to move.`);
    }
  }
  return lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity }));
}

function lineInserts(db: Database, transferId: string, lines: readonly PlannedLine[]): BatchItem<"sqlite">[] {
  const rows = lines.map((line, position) => ({
    id: `trl_${nanoid(16)}`,
    transferId,
    variantId: line.variantId,
    position,
    quantity: line.quantity,
    shippedQuantity: 0,
    receivedQuantity: 0,
    returnedQuantity: 0,
    createdAt: sql`unixepoch()`,
    updatedAt: sql`unixepoch()`,
  }));
  return chunkRowsForD1(rows, 9).map((chunk) => db.insert(inventoryTransferLines).values(chunk) as unknown as BatchItem<"sqlite">);
}

async function assertDistinctActive(db: Database, originId: string, destinationId: string): Promise<{ origin: InventoryLocationRef; destination: InventoryLocationRef }> {
  if (originId === destinationId) throw new ValidationError("Choose a destination other than the origin.");
  const [origin, destination] = await Promise.all([
    resolveActiveInventoryLocation(db, originId),
    resolveActiveInventoryLocation(db, destinationId),
  ]);
  return { origin, destination };
}

async function readHeader(db: Database, id: string) {
  const row = await db.select({
    id: inventoryTransfers.id,
    number: inventoryTransfers.number,
    status: inventoryTransfers.status,
    revision: inventoryTransfers.revision,
    originLocationId: inventoryTransfers.originLocationId,
    destinationLocationId: inventoryTransfers.destinationLocationId,
  }).from(inventoryTransfers).where(eq(inventoryTransfers.id, id)).get();
  if (!row) throw new NotFoundError("Transfer not found");
  return row;
}

const STATUS_WORDS: Record<InventoryTransferStatus, string> = {
  draft: "a draft",
  in_transit: "in transit",
  partially_received: "partially received",
  received: "received",
  cancelled: "cancelled",
};

function assertStatus(header: { number: number; status: InventoryTransferStatus }, allowed: readonly InventoryTransferStatus[], action: string): void {
  if (!allowed.includes(header.status)) {
    throw new ConflictError(`Transfer ${formatTransferNumber(header.number)} is ${STATUS_WORDS[header.status]}, so it can't be ${action}.`);
  }
}

function assertRevision(header: { revision: number }, expected: number): void {
  if (header.revision !== expected) throw new ConflictError("This transfer changed. Reload to see the latest.");
}

function subjectCondition(id: string, revision: number, statuses: readonly InventoryTransferStatus[]): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${inventoryTransfers}
    WHERE ${inventoryTransfers.id} = ${id}
      AND ${inventoryTransfers.revision} = ${revision}
      AND ${inventoryTransfers.status} IN (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})
  )`;
}

async function runGuarded(db: Database, statements: BatchItem<"sqlite">[]): Promise<void> {
  try {
    await safeBatch(db, statements as never);
  } catch (error) {
    if (isBatchGuardError(error, STALE)) throw new ConflictError("This transfer changed. Reload to see the latest.");
    if (/INVENTORY_TRANSFER_LINES_LOCKED/.test(String((error as Error)?.message ?? "") + String((error as { cause?: Error })?.cause?.message ?? ""))) {
      throw new ConflictError("A shipped transfer's lines can't change.");
    }
    throw error;
  }
}

function textOrNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value ? value : null;
}

function isNumberConflict(error: unknown): boolean {
  const text = String((error as Error)?.message ?? "") + String((error as { cause?: Error })?.cause?.message ?? "");
  return /inventory_transfers_number_unique|inventory_transfers\.number/i.test(text);
}

export async function createTransfer(db: Database, input: CreateTransferInput, actorId?: string | null): Promise<TransferDetail> {
  const data = parse(createTransferSchema, input);
  const { origin, destination } = await assertDistinctActive(db, data.originLocationId, data.destinationLocationId);
  const lines = await planLines(db, data.lines ?? []);
  const id = `trf_${nanoid(16)}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await safeBatch(db, [
        db.insert(inventoryTransfers).values({
          id,
          number: sql`(SELECT COALESCE(MAX(${inventoryTransfers.number}), ${NUMBER_START}) + 1 FROM ${inventoryTransfers})`,
          originLocationId: origin.id,
          destinationLocationId: destination.id,
          status: "draft",
          expectedOn: data.expectedOn ?? null,
          reference: textOrNull(data.reference) ?? null,
          notes: textOrNull(data.notes) ?? null,
          revision: 1,
          createdBy: actorId ?? null,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        }),
        ...lineInserts(db, id, lines),
      ] as never);
      break;
    } catch (error) {
      if (attempt < 3 && isNumberConflict(error)) continue;
      throw error;
    }
  }
  return getTransfer(db, id);
}

/** Edits a draft at the revision the merchant saw (lines are replaced when sent). */
export async function updateTransfer(db: Database, id: string, input: UpdateTransferInput): Promise<TransferDetail> {
  const data = parse(updateTransferSchema, input);
  const header = await readHeader(db, id);
  assertRevision(header, data.expectedRevision);
  assertStatus(header, ["draft"], "edited");
  const originId = data.originLocationId ?? header.originLocationId;
  const destinationId = data.destinationLocationId ?? header.destinationLocationId;
  if (originId !== header.originLocationId || destinationId !== header.destinationLocationId) {
    await assertDistinctActive(db, originId, destinationId);
  }
  const lines = data.lines !== undefined ? await planLines(db, data.lines) : null;
  await runGuarded(db, [
    buildBatchGuard(db, subjectCondition(id, data.expectedRevision, ["draft"]), STALE),
    db.update(inventoryTransfers).set({
      originLocationId: originId,
      destinationLocationId: destinationId,
      ...(data.expectedOn !== undefined ? { expectedOn: data.expectedOn } : {}),
      ...(data.reference !== undefined ? { reference: textOrNull(data.reference) } : {}),
      ...(data.notes !== undefined ? { notes: textOrNull(data.notes) } : {}),
      revision: sql`${inventoryTransfers.revision} + 1`,
      updatedAt: sql`unixepoch()`,
    }).where(and(eq(inventoryTransfers.id, id), eq(inventoryTransfers.revision, data.expectedRevision))) as unknown as BatchItem<"sqlite">,
    ...(lines
      ? [db.delete(inventoryTransferLines).where(eq(inventoryTransferLines.transferId, id)) as unknown as BatchItem<"sqlite">, ...lineInserts(db, id, lines)]
      : []),
  ]);
  return getTransfer(db, id);
}

/** Deletes a draft (nothing moved yet). */
export async function deleteTransfer(db: Database, id: string, expectedRevision: number): Promise<{ id: string; deleted: true }> {
  const header = await readHeader(db, id);
  assertRevision(header, expectedRevision);
  assertStatus(header, ["draft"], "deleted (cancel it instead)");
  await runGuarded(db, [
    buildBatchGuard(db, subjectCondition(id, expectedRevision, ["draft"]), STALE),
    db.delete(inventoryTransfers).where(and(eq(inventoryTransfers.id, id), eq(inventoryTransfers.revision, expectedRevision))) as unknown as BatchItem<"sqlite">,
  ]);
  return { id, deleted: true };
}

// ─────────────────────────────────────────
// Stock commands
// ─────────────────────────────────────────

export interface TransferCommandResult {
  transferId: string;
  displayNumber: string;
  kind: InventoryTransferMovementKind;
  status: InventoryTransferStatus;
  revision: number;
  locationId: string | null;
  lines: Array<{ lineId: string; variantId: string; sku: string; quantity: number; movementId: string; stockAfter: number }>;
}

type TransferLineRow = {
  id: string;
  variantId: string;
  quantity: number;
  shippedQuantity: number;
  receivedQuantity: number;
  returnedQuantity: number;
};

async function readLines(db: Database, id: string): Promise<TransferLineRow[]> {
  return db.select({
    id: inventoryTransferLines.id,
    variantId: inventoryTransferLines.variantId,
    quantity: inventoryTransferLines.quantity,
    shippedQuantity: inventoryTransferLines.shippedQuantity,
    receivedQuantity: inventoryTransferLines.receivedQuantity,
    returnedQuantity: inventoryTransferLines.returnedQuantity,
  }).from(inventoryTransferLines)
    .where(eq(inventoryTransferLines.transferId, id))
    .orderBy(asc(inventoryTransferLines.position), asc(inventoryTransferLines.id))
    .all();
}

/** The movement each step wrote, per line: multi-row inserts below D1's parameter ceiling. */
function linkInserts(
  db: Database,
  inputs: ReadonlyArray<{ operationKey: string; transferId: string; lineId: string; edge: StockCommandEdge; kind: InventoryTransferMovementKind; quantity: number; createdBy: string | null }>,
): BatchItem<"sqlite">[] {
  const rows = inputs.map((input) => ({
    id: `trm_${input.edge.movementId.slice(5, 37)}`,
    operationKey: input.operationKey,
    transferId: input.transferId,
    transferLineId: input.lineId,
    variantId: input.edge.before.id,
    locationId: input.edge.line.location.id,
    movementId: input.edge.movementId,
    kind: input.kind,
    quantity: input.quantity,
    createdBy: input.createdBy,
    createdAt: sql`unixepoch()`,
  }));
  return chunkRowsForD1(rows, 11).map((chunk) => db.insert(inventoryTransferMovements).values(chunk) as unknown as BatchItem<"sqlite">);
}

function commandResult(
  header: { id: string; number: number; revision: number },
  kind: InventoryTransferMovementKind,
  status: InventoryTransferStatus,
  location: InventoryLocationRef | null,
  edges: readonly StockCommandEdge[],
  lineByVariant: ReadonlyMap<string, { line: TransferLineRow; quantity: number }>,
): TransferCommandResult {
  return {
    transferId: header.id,
    displayNumber: formatTransferNumber(header.number),
    kind,
    status,
    revision: header.revision + 1,
    locationId: location?.id ?? null,
    lines: edges.map((edge) => {
      const entry = lineByVariant.get(edge.before.id)!;
      return {
        lineId: entry.line.id,
        variantId: edge.before.id,
        sku: edge.before.sku,
        quantity: entry.quantity,
        movementId: edge.movementId,
        stockAfter: edge.stockAfter,
      };
    }),
  };
}

/**
 * Ships a draft: every line leaves the origin (`transfer_out`) in one batch.
 * Refused before writing when the origin does not hold a line's units or
 * they are committed to orders.
 */
export async function shipTransfer(db: Database, id: string, input: ShipTransferInput, actorId?: string | null): Promise<TransferCommandResult> {
  const data = parse(shipTransferSchema, input);
  const operationKey = data.operationKey.trim();
  return executeStockCommand<TransferCommandResult>(db, {
    operationKey,
    commandType: "transfer_ship",
    subjectId: id,
    request: { expectedRevision: data.expectedRevision },
    createdBy: actorId ?? null,
    plan: async () => {
      const header = await readHeader(db, id);
      assertStatus(header, ["draft"], "shipped");
      assertRevision(header, data.expectedRevision);
      const { origin } = await assertDistinctActive(db, header.originLocationId, header.destinationLocationId);
      const lines = await readLines(db, id);
      if (lines.length === 0) throw new ValidationError("Add at least one product before shipping.");
      const label = formatTransferNumber(header.number);
      const lineByVariant = new Map(lines.map((line) => [line.variantId, { line, quantity: line.quantity }]));
      return {
        lines: lines.map((line) => ({
          variantId: line.variantId,
          location: origin,
          type: "transfer_out" as const,
          quantity: line.quantity,
          notes: `Shipped on transfer ${label}`,
        })),
        subjectGuard: subjectCondition(id, header.revision, ["draft"]),
        subjectRevisionAfter: header.revision + 1,
        documentStatements: (edges) => [
          db.update(inventoryTransferLines).set({
            shippedQuantity: sql`${inventoryTransferLines.quantity}`,
            updatedAt: sql`unixepoch()`,
          }).where(eq(inventoryTransferLines.transferId, id)) as unknown as BatchItem<"sqlite">,
          ...linkInserts(db, edges.map((edge) => ({
            operationKey, transferId: id, lineId: lineByVariant.get(edge.before.id)!.line.id, edge,
            kind: "ship", quantity: lineByVariant.get(edge.before.id)!.quantity, createdBy: actorId ?? null,
          }))),
          db.update(inventoryTransfers).set({
            status: "in_transit",
            shippedAt: sql`unixepoch()`,
            revision: sql`${inventoryTransfers.revision} + 1`,
            updatedAt: sql`unixepoch()`,
          }).where(and(eq(inventoryTransfers.id, id), eq(inventoryTransfers.revision, header.revision))) as unknown as BatchItem<"sqlite">,
        ],
        result: (edges) => commandResult(header, "ship", "in_transit", origin, edges, lineByVariant),
      };
    },
  });
}

/** Books some or all in-transit units at the destination (`transfer_in`). */
export async function receiveTransfer(db: Database, id: string, input: ReceiveTransferInput, actorId?: string | null): Promise<TransferCommandResult> {
  const data = parse(receiveTransferSchema, input);
  if (new Set(data.lines.map((line) => line.lineId)).size !== data.lines.length) {
    throw new ValidationError("Each transfer line appears once in a receipt.");
  }
  const operationKey = data.operationKey.trim();
  return executeStockCommand<TransferCommandResult>(db, {
    operationKey,
    commandType: "transfer_receive",
    subjectId: id,
    request: { lines: [...data.lines].sort((left, right) => left.lineId.localeCompare(right.lineId)) },
    createdBy: actorId ?? null,
    plan: async () => {
      const header = await readHeader(db, id);
      assertStatus(header, INVENTORY_TRANSFER_OPEN_STATUSES, "received");
      const destination = await resolveActiveInventoryLocation(db, header.destinationLocationId);
      const lines = await readLines(db, id);
      const byId = new Map(lines.map((line) => [line.id, line]));
      const planned = data.lines.map((requested) => {
        const line = byId.get(requested.lineId);
        if (!line) throw new NotFoundError("A line in this receipt is not on the transfer.");
        const inTransit = line.shippedQuantity - line.receivedQuantity - line.returnedQuantity;
        if (requested.quantity > inTransit) {
          throw new ConflictError(inTransit === 0
            ? "A line in this receipt has nothing left in transit."
            : `Only ${inTransit} of a line are still in transit.`);
        }
        return { line, quantity: requested.quantity };
      });
      const now = new Map(planned.map((entry) => [entry.line.id, entry.quantity]));
      const done = lines.every((line) => line.shippedQuantity - line.receivedQuantity - line.returnedQuantity - (now.get(line.id) ?? 0) === 0);
      const status: InventoryTransferStatus = done ? "received" : "partially_received";
      const lineByVariant = new Map(planned.map((entry) => [entry.line.variantId, entry]));
      const label = formatTransferNumber(header.number);
      return {
        lines: planned.map((entry) => ({
          variantId: entry.line.variantId,
          location: destination,
          type: "transfer_in" as const,
          quantity: entry.quantity,
          notes: `Received on transfer ${label}`,
          allowRetired: true,
        })),
        subjectGuard: subjectCondition(id, header.revision, INVENTORY_TRANSFER_OPEN_STATUSES),
        subjectRevisionAfter: header.revision + 1,
        documentStatements: (edges) => [
          db.update(inventoryTransferLines).set({
            receivedQuantity: sql`${inventoryTransferLines.receivedQuantity} + ${addedQuantitySql(
              planned.map((entry) => ({ id: entry.line.id, quantity: entry.quantity })),
              "inventory_transfer_lines",
            )}`,
            updatedAt: sql`unixepoch()`,
          }).where(sql`${inventoryTransferLines.id} IN (${idsFromJsonSql(planned.map((entry) => entry.line.id))})`) as unknown as BatchItem<"sqlite">,
          ...linkInserts(db, edges.map((edge) => {
            const entry = lineByVariant.get(edge.before.id)!;
            return { operationKey, transferId: id, lineId: entry.line.id, edge, kind: "receive" as const, quantity: entry.quantity, createdBy: actorId ?? null };
          })),
          db.update(inventoryTransfers).set({
            status,
            ...(done ? { receivedAt: sql`unixepoch()` } : {}),
            revision: sql`${inventoryTransfers.revision} + 1`,
            updatedAt: sql`unixepoch()`,
          }).where(and(eq(inventoryTransfers.id, id), eq(inventoryTransfers.revision, header.revision))) as unknown as BatchItem<"sqlite">,
        ],
        result: (edges) => commandResult(header, "receive", status, destination, edges, lineByVariant),
      };
    },
  });
}

/**
 * Cancels a transfer. A draft just closes; one in transit returns whatever
 * is still on the road to the origin (`transfer_in` there) in one batch.
 */
export async function cancelTransfer(db: Database, id: string, input: CancelTransferInput, actorId?: string | null): Promise<TransferCommandResult> {
  const data = parse(cancelTransferSchema, input);
  const operationKey = data.operationKey.trim();
  const header = await readHeader(db, id);
  if (header.status === "draft") {
    assertRevision(header, data.expectedRevision);
    await runGuarded(db, [
      buildBatchGuard(db, subjectCondition(id, data.expectedRevision, ["draft"]), STALE),
      db.update(inventoryTransfers).set({
        status: "cancelled",
        cancelledAt: sql`unixepoch()`,
        revision: sql`${inventoryTransfers.revision} + 1`,
        updatedAt: sql`unixepoch()`,
      }).where(and(eq(inventoryTransfers.id, id), eq(inventoryTransfers.revision, data.expectedRevision))) as unknown as BatchItem<"sqlite">,
    ]);
    return {
      transferId: id,
      displayNumber: formatTransferNumber(header.number),
      kind: "return",
      status: "cancelled",
      revision: data.expectedRevision + 1,
      locationId: null,
      lines: [],
    };
  }
  return executeStockCommand<TransferCommandResult>(db, {
    operationKey,
    commandType: "transfer_cancel",
    subjectId: id,
    request: { expectedRevision: data.expectedRevision },
    createdBy: actorId ?? null,
    plan: async () => {
      const current = await readHeader(db, id);
      assertStatus(current, INVENTORY_TRANSFER_OPEN_STATUSES, "cancelled");
      assertRevision(current, data.expectedRevision);
      const origin = await resolveActiveInventoryLocation(db, current.originLocationId);
      const lines = (await readLines(db, id))
        .map((line) => ({ line, quantity: line.shippedQuantity - line.receivedQuantity - line.returnedQuantity }))
        .filter((entry) => entry.quantity > 0);
      if (lines.length === 0) throw new ConflictError("Nothing is left in transit to return.");
      const lineByVariant = new Map(lines.map((entry) => [entry.line.variantId, entry]));
      const label = formatTransferNumber(current.number);
      return {
        lines: lines.map((entry) => ({
          variantId: entry.line.variantId,
          location: origin,
          type: "transfer_in" as const,
          quantity: entry.quantity,
          notes: `Returned to origin: transfer ${label} cancelled`,
          allowRetired: true,
        })),
        subjectGuard: subjectCondition(id, current.revision, INVENTORY_TRANSFER_OPEN_STATUSES),
        subjectRevisionAfter: current.revision + 1,
        documentStatements: (edges) => [
          db.update(inventoryTransferLines).set({
            returnedQuantity: sql`${inventoryTransferLines.returnedQuantity} + ${addedQuantitySql(
              lines.map((entry) => ({ id: entry.line.id, quantity: entry.quantity })),
              "inventory_transfer_lines",
            )}`,
            updatedAt: sql`unixepoch()`,
          }).where(sql`${inventoryTransferLines.id} IN (${idsFromJsonSql(lines.map((entry) => entry.line.id))})`) as unknown as BatchItem<"sqlite">,
          ...linkInserts(db, edges.map((edge) => {
            const entry = lineByVariant.get(edge.before.id)!;
            return { operationKey, transferId: id, lineId: entry.line.id, edge, kind: "return" as const, quantity: entry.quantity, createdBy: actorId ?? null };
          })),
          db.update(inventoryTransfers).set({
            status: "cancelled",
            cancelledAt: sql`unixepoch()`,
            revision: sql`${inventoryTransfers.revision} + 1`,
            updatedAt: sql`unixepoch()`,
          }).where(and(eq(inventoryTransfers.id, id), eq(inventoryTransfers.revision, current.revision))) as unknown as BatchItem<"sqlite">,
        ],
        result: (edges) => commandResult(current, "return", "cancelled", origin, edges, lineByVariant),
      };
    },
  });
}
