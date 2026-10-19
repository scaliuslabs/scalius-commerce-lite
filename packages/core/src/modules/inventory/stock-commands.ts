// Multi-SKU stock commands (migration 0109): receiving a purchase order and
// shipping, receiving or cancelling a transfer.
//
// One command commits as ONE batch, or not at all:
//   1. a subject guard (the purchase order or transfer is still at the
//      revision and status the command was planned from);
//   2. per SKU, a ledger-v2 movement claim and the stockVersion CAS update
//      of the counters (and, for a receipt that updates the unit cost, the
//      new cost guarded on the cost that was read);
//   3. CAS guards proving every SKU landed exactly on its planned edge, so a
//      lost compare-and-set aborts the whole batch instead of committing part
//      of it (a zero-row UPDATE does not fail a batch by itself);
//   4. the inventory_commands replay row under the merchant's operation key;
//   5. the command's own document writes (line progress, receipt/transfer
//      links, the subject's status and revision);
//   6. the product buyer-state refresh for the SKUs it moved.
// The level triggers keep sum(levels) = stock: a removal at a location
// without the units aborts the batch (INVENTORY_LEVEL_SHORTFALL). An exact
// retry replays the committed result; a changed request under the same key is
// refused. A lost race re-plans from fresh reads (bounded retries).

import type { BatchItem } from "drizzle-orm/batch";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database, D1_ID_CHUNK_SIZE } from "@scalius/database/client";
import {
  inventoryCommands,
  inventoryMovements,
  productVariants,
  type InventoryCommandType,
} from "@scalius/database/schema";
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { buildStockMovementClaim, type StockMovementClaimType } from "./stock-movement-claims";
import {
  assertInventoryLocationCovers,
  inventoryLocationErrorFrom,
  isInventoryLevelShortfallError,
  isInventoryLocationRequiredError,
  type InventoryLocationRef,
} from "./locations";
import { normalizeInventoryOperationKey } from "./inventory-operations";
import { checkAndAlertLowStock } from "./alerts";
import { catalogBuyerStateRefreshStatementsForSkus, digitalStockError, isDigitalKind } from "../products";
import { mapWithBoundedConcurrency } from "../../utils/bounded-concurrency";

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 40;
/** A command moves at most this many SKUs (one batch; purchase orders and transfers cap their lines). */
export const STOCK_COMMAND_MAX_LINES = 100;
/** Lines per CAS guard statement: 4 bound values each, below D1's 100. */
const GUARD_CHUNK = 20;
const CAS_MARKER = "STOCK_COMMAND_CAS";
const SUBJECT_MARKER = "STOCK_COMMAND_SUBJECT_STALE";

export interface StockCommandSkuState {
  id: string;
  sku: string;
  productId: string;
  stock: number;
  reservedStock: number;
  preorderStock: number;
  stockVersion: number;
  costMinor: number | null;
  fulfillmentKind: string;
  deletedAt: Date | null;
}

export interface StockCommandLine {
  variantId: string;
  location: InventoryLocationRef;
  type: Extract<StockMovementClaimType, "received" | "transfer_out" | "transfer_in" | "adjusted">;
  /**
   * Units moved; the type gives the sign (transfer_out removes). An
   * `adjusted` line (a counted quantity set by a bulk stock run) carries its
   * own sign: a non-zero delta at its location.
   */
  quantity: number;
  notes: string;
  /**
   * Received at this unit cost and the SKU's cost becomes the weighted
   * average of its on-hand units and these (receipts only).
   */
  averageCostAtMinor?: number;
  /** Units already on the road may still arrive for a SKU retired meanwhile. */
  allowRetired?: boolean;
}

export interface StockCommandEdge {
  line: StockCommandLine;
  movementId: string;
  before: StockCommandSkuState;
  stockAfter: number;
  stockVersionAfter: number;
  costAfterMinor: number | null;
}

export interface StockCommandPlan<R> {
  lines: StockCommandLine[];
  /** True while the subject is still what this plan was built from (the batch's first statement). */
  subjectGuard: SQL;
  /** The subject's revision once this command commits (orders its commands; unique per subject). */
  subjectRevisionAfter: number;
  /** The command's document writes, committed after the counter edges. */
  documentStatements: (edges: readonly StockCommandEdge[]) => BatchItem<"sqlite">[];
  /** The committed result: stored with the operation key and returned on replay. */
  result: (edges: readonly StockCommandEdge[]) => R;
}

export interface StockCommandInput<R> {
  operationKey: string;
  /**
   * What makes a retry safe. `"operation_key"` (the default): the
   * `inventory_commands` row, replayed by key and request hash. `"subject"`:
   * the subject guard alone, for a subject that advances its own revision in
   * `documentStatements` (a bulk run's chunk counter); no command row is
   * written, and a lost subject race throws {@link StockCommandSubjectMovedError}.
   */
  replay?: "operation_key" | "subject";
  /** A row's command type; `bulk_set_quantities` (a bulk stock run's chunk) only with `replay: "subject"`. */
  commandType: InventoryCommandType | "bulk_set_quantities";
  subjectId: string;
  /** The canonical request (without the key): its hash is the replay identity. */
  request: unknown;
  createdBy?: string | null;
  /** Re-read the subject and plan the command; called again after a lost race. */
  plan: () => Promise<StockCommandPlan<R>>;
}

/**
 * The quantity a document line gains in this command, as a correlated
 * subquery over one JSON parameter (`[{id, quantity}]`): every line's
 * progress in a single UPDATE. `table` qualifies the outer row explicitly
 * (json_each has an `id` column of its own).
 */
export function addedQuantitySql(entries: ReadonlyArray<{ id: string; quantity: number }>, table: string): SQL<number> {
  const json = JSON.stringify(entries.map((entry) => ({ id: entry.id, q: entry.quantity })));
  return sql<number>`COALESCE((
    SELECT CAST(json_extract(added.value, '$.q') AS INTEGER) FROM json_each(${json}) AS added
    WHERE CAST(json_extract(added.value, '$.id') AS TEXT) = ${sql.raw(`"${table}"."id"`)}
  ), 0)`;
}

/**
 * The admin behind a command: its `created_by`, or the admin a scanner
 * session acts for (`scanner:<adminId>`), so receipts made by scan show who.
 */
export function commandActorUserIdSql(): SQL<string | null> {
  return sql<string | null>`(CASE WHEN ${inventoryCommands.createdBy} LIKE 'scanner:%' THEN substr(${inventoryCommands.createdBy}, 9) ELSE ${inventoryCommands.createdBy} END)`;
}

/** The ids in one JSON parameter, for `id IN (...)`. */
export function idsFromJsonSql(ids: readonly string[]): SQL {
  return sql`SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)})`;
}

export async function hashStockCommandRequest(commandType: StockCommandInput<unknown>["commandType"], subjectId: string, request: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({ commandType, subjectId, request })),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function movementIdFor(operationKey: string, variantId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`stock-command:${operationKey}:${variantId}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `imov_${hex.slice(0, 48)}`;
}

/**
 * The weighted moving average a receipt leaves: the SKU's on-hand units at
 * the cost it had plus the received units at their unit cost, rounded half up
 * to a whole minor unit. Without a known cost, or with nothing on hand, the
 * receipt's unit cost is the new cost. Exact integer arithmetic.
 */
export function weightedAverageCostMinor(input: {
  onHand: number;
  currentCostMinor: number | null;
  receivedQuantity: number;
  unitCostMinor: number;
}): number {
  const { onHand, currentCostMinor, receivedQuantity, unitCostMinor } = input;
  if (!Number.isSafeInteger(receivedQuantity) || receivedQuantity < 1) {
    throw new ValidationError("A receipt moves at least one unit");
  }
  if (!Number.isSafeInteger(unitCostMinor) || unitCostMinor < 0) {
    throw new ValidationError("A unit cost is a whole, non-negative number of minor units");
  }
  if (currentCostMinor === null || onHand <= 0) return unitCostMinor;
  const units = BigInt(onHand) + BigInt(receivedQuantity);
  const total = BigInt(onHand) * BigInt(currentCostMinor) + BigInt(receivedQuantity) * BigInt(unitCostMinor);
  const average = (total * 2n + units) / (units * 2n);
  if (average > BigInt(Number.MAX_SAFE_INTEGER)) throw new ValidationError("The average cost is out of range");
  return Number(average);
}

/** A subject-replayed command lost its subject race: another writer committed the subject's next revision. */
export class StockCommandSubjectMovedError extends ConflictError {
  constructor() {
    super("The subject of this stock command moved on while it was being saved.");
    this.name = "StockCommandSubjectMovedError";
  }
}

export async function readStockCommandSkus(
  db: Database,
  variantIds: readonly string[],
): Promise<Map<string, StockCommandSkuState>> {
  const unique = [...new Set(variantIds)];
  const states = new Map<string, StockCommandSkuState>();
  for (let index = 0; index < unique.length; index += D1_ID_CHUNK_SIZE) {
    const rows = await db.select({
      id: productVariants.id,
      sku: productVariants.sku,
      productId: productVariants.productId,
      stock: productVariants.stock,
      reservedStock: productVariants.reservedStock,
      preorderStock: productVariants.preorderStock,
      stockVersion: productVariants.stockVersion,
      costMinor: productVariants.costMinor,
      fulfillmentKind: productVariants.fulfillmentKind,
      deletedAt: productVariants.deletedAt,
    })
      .from(productVariants)
      .where(inArray(productVariants.id, unique.slice(index, index + D1_ID_CHUNK_SIZE)))
      .all();
    for (const row of rows) states.set(row.id, row);
  }
  return states;
}

type StoredCommand = { requestHash: string; commandType: string; subjectId: string; resultPayload: string };

async function readCommand(db: Database, operationKey: string): Promise<StoredCommand | null> {
  const row = await db.select({
    requestHash: inventoryCommands.requestHash,
    commandType: inventoryCommands.commandType,
    subjectId: inventoryCommands.subjectId,
    resultPayload: inventoryCommands.resultPayload,
  }).from(inventoryCommands).where(eq(inventoryCommands.operationKey, operationKey)).get();
  return row ?? null;
}

function replay<R>(row: StoredCommand, commandType: string, subjectId: string, requestHash: string): R {
  if (row.commandType !== commandType || row.subjectId !== subjectId || row.requestHash !== requestHash) {
    throw new ConflictError("This operation key was already used for a different inventory request.");
  }
  try {
    return JSON.parse(row.resultPayload) as R;
  } catch {
    throw new ServiceUnavailableError("The committed inventory command result is unreadable; nothing was retried.");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Every edge landed: the SKU sits on its planned version and stock, and its
 * movement is the edge into it. The SKU is still physical, so a SKU that
 * turned digital meanwhile (its stock is its licence keys) loses the race and
 * the re-plan refuses it.
 */
function casGuards(db: Database, edges: readonly StockCommandEdge[]): BatchItem<"sqlite">[] {
  const guards: BatchItem<"sqlite">[] = [];
  for (let index = 0; index < edges.length; index += GUARD_CHUNK) {
    const conditions = edges.slice(index, index + GUARD_CHUNK).map((edge) => sql`EXISTS (
      SELECT 1 FROM ${productVariants} AS sku
      JOIN ${inventoryMovements} AS edge ON edge.id = ${edge.movementId}
      WHERE sku.id = ${edge.before.id}
        AND sku.stock_version = ${edge.stockVersionAfter}
        AND sku.stock = ${edge.stockAfter}
        AND sku.fulfillment_kind = 'physical'
        AND edge.variant_id = sku.id
        AND edge.stock_version_after = sku.stock_version
    )`);
    guards.push(buildBatchGuard(db, sql.join(conditions, sql` AND `), CAS_MARKER));
  }
  return guards;
}

function counterUpdate(db: Database, edge: StockCommandEdge): BatchItem<"sqlite"> {
  const { before, line } = edge;
  const removal = edge.stockAfter < before.stock;
  const costChanges = line.averageCostAtMinor !== undefined;
  return db.update(productVariants)
    .set({
      stock: edge.stockAfter,
      stockVersion: sql`${productVariants.stockVersion} + 1`,
      ...(costChanges ? { costMinor: edge.costAfterMinor } : {}),
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(productVariants.id, before.id),
      eq(productVariants.stockVersion, before.stockVersion),
      line.allowRetired ? undefined : isNull(productVariants.deletedAt),
      removal ? sql`${productVariants.reservedStock} <= ${edge.stockAfter}` : undefined,
      costChanges
        ? before.costMinor === null ? isNull(productVariants.costMinor) : eq(productVariants.costMinor, before.costMinor)
        : undefined,
    ))
    .returning({ id: productVariants.id });
}

function assertLinesMovable(lines: readonly StockCommandLine[], skus: Map<string, StockCommandSkuState>): void {
  if (lines.length === 0) throw new ValidationError("Choose at least one line to move.");
  if (lines.length > STOCK_COMMAND_MAX_LINES) {
    throw new ValidationError(`A single stock command moves at most ${STOCK_COMMAND_MAX_LINES} SKUs.`);
  }
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.variantId)) throw new ValidationError("Each SKU appears once in a stock command.");
    seen.add(line.variantId);
    if (
      !Number.isSafeInteger(line.quantity) ||
      (line.type === "adjusted" ? line.quantity === 0 : line.quantity < 1)
    ) {
      throw new ValidationError(line.type === "adjusted"
        ? "A counted quantity line changes the stock."
        : "Quantities are whole numbers of at least 1.");
    }
    const sku = skus.get(line.variantId);
    if (!sku) throw new NotFoundError("A SKU on this document no longer exists.");
    if (sku.deletedAt && !line.allowRetired) {
      throw new ConflictError(`SKU ${sku.sku} was removed from its product. Restore it, or leave it out.`);
    }
    // A digital SKU's stock is its licence keys: no receipt or transfer moves it.
    if (isDigitalKind(sku.fulfillmentKind)) throw digitalStockError({ sku: sku.sku, variantId: sku.id });
    if (sku.fulfillmentKind !== "physical") {
      throw new ValidationError(`SKU ${sku.sku} is not a physical item, so it has no stock to move.`);
    }
    if (lineDelta(line) < 0) {
      const after = sku.stock + lineDelta(line);
      if (after < sku.reservedStock) {
        throw new ConflictError(
          `SKU ${sku.sku} has ${Math.max(0, sku.stock - sku.reservedStock)} units free to move: ${sku.reservedStock} of its ${sku.stock} on hand are committed to orders.`,
        );
      }
    }
  }
}

/** The signed change a line makes to the SKU's stock. */
function lineDelta(line: StockCommandLine): number {
  return line.type === "transfer_out" ? -line.quantity : line.quantity;
}

async function planEdges(
  operationKey: string,
  lines: readonly StockCommandLine[],
  skus: Map<string, StockCommandSkuState>,
): Promise<StockCommandEdge[]> {
  return Promise.all(lines.map(async (line) => {
    const before = skus.get(line.variantId)!;
    const delta = lineDelta(line);
    const costAfterMinor = line.averageCostAtMinor === undefined
      ? before.costMinor
      : weightedAverageCostMinor({
        onHand: before.stock,
        currentCostMinor: before.costMinor,
        receivedQuantity: line.quantity,
        unitCostMinor: line.averageCostAtMinor,
      });
    return {
      line,
      movementId: await movementIdFor(operationKey, line.variantId),
      before,
      stockAfter: before.stock + delta,
      stockVersionAfter: before.stockVersion + 1,
      costAfterMinor,
    };
  }));
}

async function assertLocationsCover(db: Database, lines: readonly StockCommandLine[]): Promise<void> {
  const byLocation = new Map<string, { location: InventoryLocationRef; removals: Array<{ variantId: string; quantity: number }> }>();
  for (const line of lines) {
    if (lineDelta(line) >= 0) continue;
    const group = byLocation.get(line.location.id) ?? { location: line.location, removals: [] };
    group.removals.push({ variantId: line.variantId, quantity: -lineDelta(line) });
    byLocation.set(line.location.id, group);
  }
  for (const group of byLocation.values()) await assertInventoryLocationCovers(db, group.location, group.removals);
}

function isUniqueViolation(error: unknown): boolean {
  const text = String((error as { message?: unknown })?.message ?? "")
    + String((error as { cause?: { message?: unknown } })?.cause?.message ?? "");
  return /unique|duplicate key|PRIMARY KEY/i.test(text);
}

/**
 * Plans and commits one multi-SKU stock command (see the file comment), or
 * replays the result committed earlier under the same operation key.
 */
export async function executeStockCommand<R>(db: Database, input: StockCommandInput<R>): Promise<R> {
  const operationKey = normalizeInventoryOperationKey(input.operationKey);
  const requestHash = await hashStockCommandRequest(input.commandType, input.subjectId, input.request);
  const keyed = (input.replay ?? "operation_key") === "operation_key";
  if (keyed && input.commandType === "bulk_set_quantities") {
    throw new ValidationError("A bulk stock chunk is replayed by its run, not an operation key.");
  }
  const existing = keyed ? await readCommand(db, operationKey) : null;
  if (existing) return replay<R>(existing, input.commandType, input.subjectId, requestHash);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const plan = await input.plan();
    const skus = await readStockCommandSkus(db, plan.lines.map((line) => line.variantId));
    assertLinesMovable(plan.lines, skus);
    if (attempt === 0) await assertLocationsCover(db, plan.lines);
    const edges = await planEdges(operationKey, plan.lines, skus);
    const result = plan.result(edges);
    const statements: BatchItem<"sqlite">[] = [
      buildBatchGuard(db, plan.subjectGuard, SUBJECT_MARKER),
      ...edges.flatMap((edge) => [
        buildStockMovementClaim(db, {
          movementId: edge.movementId,
          variantId: edge.before.id,
          pool: "regular",
          quantity: edge.stockAfter - edge.before.stock,
          before: edge.before,
          after: {
            stock: edge.stockAfter,
            reservedStock: edge.before.reservedStock,
            preorderStock: edge.before.preorderStock,
            stockVersion: edge.stockVersionAfter,
          },
          notes: edge.line.notes,
          adminUserId: input.createdBy ?? undefined,
          locationId: edge.line.location.id,
          type: edge.line.type,
          allowRetired: edge.line.allowRetired,
        }) as unknown as BatchItem<"sqlite">,
        counterUpdate(db, edge),
      ]),
      ...casGuards(db, edges),
      ...(keyed
        ? [db.insert(inventoryCommands).values({
          operationKey,
          requestHash,
          commandType: input.commandType as InventoryCommandType,
          subjectId: input.subjectId,
          subjectRevision: plan.subjectRevisionAfter,
          resultPayload: JSON.stringify(result),
          createdBy: input.createdBy ?? null,
          createdAt: sql`unixepoch()`,
        }) as unknown as BatchItem<"sqlite">]
        : []),
      ...plan.documentStatements(edges),
      ...catalogBuyerStateRefreshStatementsForSkus(db, edges.map((edge) => edge.before.id)),
    ];

    try {
      await safeBatch(db, statements as never);
    } catch (error) {
      if (isInventoryLevelShortfallError(error) || isInventoryLocationRequiredError(error)) {
        const removal = plan.lines.find((line) => lineDelta(line) < 0);
        throw inventoryLocationErrorFrom(error, removal?.location.name);
      }
      if (!keyed && isBatchGuardError(error, SUBJECT_MARKER)) throw new StockCommandSubjectMovedError();
      const raced = keyed ? await readCommand(db, operationKey) : null;
      if (raced) return replay<R>(raced, input.commandType, input.subjectId, requestHash);
      const lostRace = isBatchGuardError(error, CAS_MARKER) || isBatchGuardError(error, SUBJECT_MARKER) || isUniqueViolation(error);
      if (!lostRace) throw error;
      if (attempt < MAX_ATTEMPTS - 1) await sleep(BASE_BACKOFF_MS * 2 ** attempt);
      continue;
    }

    await mapWithBoundedConcurrency(edges, 4, async (edge) => {
      try {
        await checkAndAlertLowStock(db, edge.before.id);
      } catch (error) {
        // The command committed; an alert refresh never turns it into a failure.
        console.warn("[inventory/stock-command] low-stock refresh failed", error instanceof Error ? error.name : "unknown");
      }
    });
    return result;
  }
  throw new ConflictError("Stock changed while this was being saved. Reload and try again.");
}
