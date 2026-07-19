import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  notExists,
  sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";

import { safeBatch, type Database } from "@scalius/database/client";
import {
  ItemFulfillmentStatus,
  OrderStatus,
  orderItems,
  orderReturnCommands,
  orderReturnLines,
  orderReturnReceiptLines,
  orderReturns,
  orders,
} from "@scalius/database/schema";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@scalius/core/errors";
import { applyClaimedInventoryEntryBatch } from "../inventory/inventory-transitions";
import type {
  ApproveOrderReturnInput,
  CancelOrderReturnInput,
  CreateOrderReturnInput,
  ReceiveOrderReturnInput,
} from "./order-returns.validation";
import { receiveOrderReturnSchema } from "./order-returns.validation";

export const ORDER_RETURN_STATUSES = [
  "requested",
  "approved",
  "receiving",
  "completed",
  "rejected",
  "cancelled",
] as const;

export type OrderReturnStatus = typeof ORDER_RETURN_STATUSES[number];
export type OrderReturnActor = {
  type: "admin" | "customer" | "guest_receipt" | "system";
  id?: string | null;
};
export type OrderReturnSource =
  | "admin"
  | "support_request"
  | "cod_return_to_sender";

export interface OrderReturnLineView {
  id: string;
  orderItemId: string;
  variantId: string | null;
  inventoryTracked: boolean;
  requestedQuantity: number;
  approvedQuantity: number;
  receivedQuantity: number;
  restockQuantity: number;
  damagedQuantity: number;
  rejectedQuantity: number;
  /** Quantity still available for a new return case across this order item. */
  remainingReturnableQuantity: number;
  reason: string | null;
  notes: string | null;
}

export interface OrderReturnView {
  id: string;
  orderId: string;
  status: OrderReturnStatus;
  reason: string;
  notes: string | null;
  actorType: string;
  actorId: string | null;
  source: OrderReturnSource;
  sourceReferenceId: string | null;
  version: number;
  requestedAt: Date;
  approvedAt: Date | null;
  receivingStartedAt: Date | null;
  completedAt: Date | null;
  rejectedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  receiptRecovery: { required: true; startedAt: number | null } | null;
  receipts: OrderReturnReceiptView[];
  lines: OrderReturnLineView[];
}

export interface OrderReturnReceiptView {
  id: string;
  returnLineId: string;
  receivedQuantity: number;
  restockQuantity: number;
  damagedQuantity: number;
  actorType: string;
  actorId: string | null;
  inventoryMovementId: string | null;
  notes: string | null;
  createdAt: Date;
}

export interface OrderReturnCommandResult {
  orderId: string;
  returnId: string;
  status: OrderReturnStatus;
  version: number;
  restockedQuantity: number;
  wholeOrderReturned: boolean;
}

type ReturnCommandType = "create" | "approve" | "receive" | "cancel";
type ReturnCommandReplay = {
  requestHash: string;
  status: string;
  responsePayload: string | null;
  actorType: OrderReturnActor["type"];
  actorId: string | null;
};

const RETURNABLE_ORDER_STATUSES = new Set<string>([
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
]);
const FULFILLED_ITEM_STATUSES = new Set<string>([
  ItemFulfillmentStatus.SHIPPED,
  ItemFulfillmentStatus.DELIVERED,
]);

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function buildCommandIdentity(
  orderId: string,
  returnId: string,
  commandType: ReturnCommandType,
  commandKey: string,
  payload: unknown,
) {
  const requestHash = await sha256Hex(stableStringify({
    orderId,
    returnId,
    commandType,
    payload,
  }));
  const idHash = await sha256Hex(`order-return-command\0${orderId}\0${commandKey}`);
  return { requestHash, commandId: `orc_${idHash.slice(0, 32)}` };
}

function parseCommandResult(payload: string | null): OrderReturnCommandResult {
  if (!payload) {
    throw new ServiceUnavailableError(
      "Return command is still processing. Retry with the same command key.",
    );
  }
  try {
    return JSON.parse(payload) as OrderReturnCommandResult;
  } catch {
    throw new ServiceUnavailableError(
      "Stored return command result is unreadable and requires reconciliation.",
    );
  }
}

async function readCommandReplay(
  db: Database,
  orderId: string,
  commandKey: string,
): Promise<ReturnCommandReplay | undefined> {
  return db
    .select({
      requestHash: orderReturnCommands.requestHash,
      status: orderReturnCommands.status,
      responsePayload: orderReturnCommands.responsePayload,
      actorType: orderReturnCommands.actorType,
      actorId: orderReturnCommands.actorId,
    })
    .from(orderReturnCommands)
    .where(and(
      eq(orderReturnCommands.orderId, orderId),
      eq(orderReturnCommands.commandKey, commandKey),
    ))
    .get();
}

function resolveReplay(
  replay: ReturnCommandReplay | undefined,
  requestHash: string,
): OrderReturnCommandResult | null {
  if (!replay) return null;
  if (replay.requestHash !== requestHash) {
    throw new ConflictError(
      "Return command key was already used with a different payload.",
    );
  }
  if (replay.status !== "committed") {
    throw new ServiceUnavailableError(
      "Return command is still processing. Retry with the same command key.",
    );
  }
  return parseCommandResult(replay.responsePayload);
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed") || message.includes("constraint failed");
}

function uniqueIds(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError(`${label} cannot contain duplicate rows.`);
  }
}

const returnHeaderFields = {
  id: orderReturns.id,
  orderId: orderReturns.orderId,
  status: orderReturns.status,
  reason: orderReturns.reason,
  notes: orderReturns.notes,
  actorType: orderReturns.actorType,
  actorId: orderReturns.actorId,
  source: orderReturns.source,
  sourceReferenceId: orderReturns.sourceReferenceId,
  version: orderReturns.version,
  activeCommandKey: orderReturns.activeCommandKey,
  activeCommandStartedAt: orderReturns.activeCommandStartedAt,
  requestedAt: orderReturns.requestedAt,
  approvedAt: orderReturns.approvedAt,
  receivingStartedAt: orderReturns.receivingStartedAt,
  completedAt: orderReturns.completedAt,
  rejectedAt: orderReturns.rejectedAt,
  cancelledAt: orderReturns.cancelledAt,
  createdAt: orderReturns.createdAt,
  updatedAt: orderReturns.updatedAt,
};

const returnLineFields = {
  id: orderReturnLines.id,
  orderItemId: orderReturnLines.orderItemId,
  variantId: orderReturnLines.variantId,
  inventoryTracked: orderReturnLines.inventoryTracked,
  requestedQuantity: orderReturnLines.requestedQuantity,
  approvedQuantity: orderReturnLines.approvedQuantity,
  receivedQuantity: orderReturnLines.receivedQuantity,
  restockQuantity: orderReturnLines.restockQuantity,
  damagedQuantity: orderReturnLines.damagedQuantity,
  rejectedQuantity: orderReturnLines.rejectedQuantity,
  reason: orderReturnLines.reason,
  notes: orderReturnLines.notes,
};

const returnReceiptFields = {
  id: orderReturnReceiptLines.id,
  returnLineId: orderReturnReceiptLines.returnLineId,
  receivedQuantity: orderReturnReceiptLines.receivedQuantity,
  restockQuantity: orderReturnReceiptLines.restockQuantity,
  damagedQuantity: orderReturnReceiptLines.damagedQuantity,
  actorType: orderReturnReceiptLines.actorType,
  actorId: orderReturnReceiptLines.actorId,
  inventoryMovementId: orderReturnReceiptLines.inventoryMovementId,
  notes: orderReturnReceiptLines.notes,
  createdAt: orderReturnReceiptLines.createdAt,
};

async function loadRemainingReturnableByItem(
  db: Database,
  orderId: string,
): Promise<Map<string, number>> {
  const [items, committedRows] = await Promise.all([
    db.select({ id: orderItems.id, quantity: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .all(),
    db.select({
      orderItemId: orderReturnLines.orderItemId,
      requestedQuantity: orderReturnLines.requestedQuantity,
      approvedQuantity: orderReturnLines.approvedQuantity,
      status: orderReturns.status,
    })
      .from(orderReturnLines)
      .innerJoin(orderReturns, eq(orderReturns.id, orderReturnLines.returnId))
      .where(eq(orderReturnLines.orderId, orderId))
      .all(),
  ]);
  const committedByItem = new Map<string, number>();
  for (const row of committedRows) {
    const committed = row.status === "requested"
      ? row.requestedQuantity
      : row.status === "approved" || row.status === "receiving" || row.status === "completed"
        ? row.approvedQuantity
        : 0;
    committedByItem.set(row.orderItemId, (committedByItem.get(row.orderItemId) ?? 0) + committed);
  }
  return new Map(items.map((item) => [
    item.id,
    Math.max(0, item.quantity - (committedByItem.get(item.id) ?? 0)),
  ]));
}

export async function getOrderReturn(
  db: Database,
  orderId: string,
  returnId: string,
): Promise<OrderReturnView> {
  const header = await db
    .select(returnHeaderFields)
    .from(orderReturns)
    .where(and(eq(orderReturns.id, returnId), eq(orderReturns.orderId, orderId)))
    .get();
  if (!header) throw new NotFoundError("Order return not found");
  const [lines, receipts] = await Promise.all([
    db.select(returnLineFields)
      .from(orderReturnLines)
      .where(eq(orderReturnLines.returnId, returnId))
      .orderBy(orderReturnLines.createdAt)
      .all(),
    db.select(returnReceiptFields)
      .from(orderReturnReceiptLines)
      .where(eq(orderReturnReceiptLines.returnId, returnId))
      .orderBy(orderReturnReceiptLines.createdAt)
      .all(),
  ]);
  const remainingByItem = await loadRemainingReturnableByItem(db, orderId);
  const {
    activeCommandKey,
    activeCommandStartedAt,
    ...publicHeader
  } = header;
  return {
    ...publicHeader,
    status: header.status as OrderReturnStatus,
    source: header.source as OrderReturnSource,
    receiptRecovery: activeCommandKey
      ? { required: true, startedAt: activeCommandStartedAt }
      : null,
    receipts,
    lines: lines.map((line) => ({
      ...line,
      remainingReturnableQuantity: remainingByItem.get(line.orderItemId) ?? 0,
    })),
  };
}

export async function listOrderReturns(
  db: Database,
  orderId: string,
): Promise<OrderReturnView[]> {
  const headers = await db
    .select(returnHeaderFields)
    .from(orderReturns)
    .where(eq(orderReturns.orderId, orderId))
    .orderBy(sql`${orderReturns.createdAt} DESC`)
    .all();
  if (headers.length === 0) return [];
  const lines = await db
    .select({ returnId: orderReturnLines.returnId, ...returnLineFields })
    .from(orderReturnLines)
    .where(inArray(orderReturnLines.returnId, headers.map((header) => header.id)))
    .orderBy(orderReturnLines.createdAt)
    .all();
  const receipts = await db
    .select({ returnId: orderReturnReceiptLines.returnId, ...returnReceiptFields })
    .from(orderReturnReceiptLines)
    .where(inArray(orderReturnReceiptLines.returnId, headers.map((header) => header.id)))
    .orderBy(orderReturnReceiptLines.createdAt)
    .all();
  const linesByReturn = new Map<string, OrderReturnLineView[]>();
  const remainingByItem = await loadRemainingReturnableByItem(db, orderId);
  for (const line of lines) {
    const { returnId, ...view } = line;
    const group = linesByReturn.get(returnId) ?? [];
    group.push({
      ...view,
      remainingReturnableQuantity: remainingByItem.get(view.orderItemId) ?? 0,
    });
    linesByReturn.set(returnId, group);
  }
  const receiptsByReturn = new Map<string, OrderReturnReceiptView[]>();
  for (const receipt of receipts) {
    const { returnId, ...view } = receipt;
    const group = receiptsByReturn.get(returnId) ?? [];
    group.push(view);
    receiptsByReturn.set(returnId, group);
  }
  return headers.map((header) => {
    const { activeCommandKey, activeCommandStartedAt, ...publicHeader } = header;
    return {
      ...publicHeader,
      status: header.status as OrderReturnStatus,
      source: header.source as OrderReturnSource,
      receiptRecovery: activeCommandKey
        ? { required: true as const, startedAt: activeCommandStartedAt }
        : null,
      receipts: receiptsByReturn.get(header.id) ?? [],
      lines: linesByReturn.get(header.id) ?? [],
    };
  });
}

async function resultWithOrderStatus(
  db: Database,
  result: Omit<OrderReturnCommandResult, "wholeOrderReturned">,
): Promise<OrderReturnCommandResult> {
  const order = await db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, result.orderId))
    .get();
  return { ...result, wholeOrderReturned: order?.status === OrderStatus.RETURNED };
}

export async function createOrderReturn(
  db: Database,
  orderId: string,
  input: CreateOrderReturnInput,
  actor: OrderReturnActor,
  options: { source?: OrderReturnSource; sourceReferenceId?: string | null } = {},
): Promise<OrderReturnCommandResult> {
  uniqueIds(input.lines.map((line) => line.orderItemId), "Return lines");
  const source = options.source ?? "admin";
  const returnId = `ret_${nanoid(20)}`;
  const identity = await buildCommandIdentity(
    orderId,
    "new",
    "create",
    input.commandKey,
    { ...input, source, sourceReferenceId: options.sourceReferenceId ?? null },
  );
  const replay = resolveReplay(
    await readCommandReplay(db, orderId, input.commandKey),
    identity.requestHash,
  );
  if (replay) return resultWithOrderStatus(db, replay);

  const order = await db
    .select({ id: orders.id, status: orders.status, version: orders.version })
    .from(orders)
    .where(eq(orders.id, orderId))
    .get();
  if (!order) throw new NotFoundError("Order not found");
  if (order.version !== input.expectedOrderVersion) {
    throw new ConflictError("Order changed while the return was being prepared. Reload and try again.");
  }
  if (!RETURNABLE_ORDER_STATUSES.has(order.status)) {
    throw new ValidationError("Returns can be requested only after an order is shipped, delivered, or completed.");
  }

  const requestedIds = input.lines.map((line) => line.orderItemId);
  const itemRows = await db
    .select({
      id: orderItems.id,
      quantity: orderItems.quantity,
      variantId: orderItems.variantId,
      inventoryTracked: orderItems.inventoryTracked,
      fulfillmentStatus: orderItems.fulfillmentStatus,
    })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), inArray(orderItems.id, requestedIds)))
    .all();
  if (itemRows.length !== requestedIds.length) {
    throw new ValidationError("One or more return lines no longer belong to this order.");
  }
  const itemById = new Map(itemRows.map((item) => [item.id, item]));
  for (const line of input.lines) {
    const item = itemById.get(line.orderItemId)!;
    if (!FULFILLED_ITEM_STATUSES.has(item.fulfillmentStatus)) {
      throw new ValidationError("Only shipped or delivered order items can be returned.", {
        orderItemId: item.id,
      });
    }
    if (item.inventoryTracked && !item.variantId) {
      throw new ValidationError("Tracked order item is missing its sellable SKU identity.", {
        orderItemId: item.id,
      });
    }
  }

  const existing = await db
    .select({
      orderItemId: orderReturnLines.orderItemId,
      requestedQuantity: orderReturnLines.requestedQuantity,
      approvedQuantity: orderReturnLines.approvedQuantity,
      status: orderReturns.status,
    })
    .from(orderReturnLines)
    .innerJoin(orderReturns, eq(orderReturns.id, orderReturnLines.returnId))
    .where(and(
      eq(orderReturnLines.orderId, orderId),
      inArray(orderReturnLines.orderItemId, requestedIds),
    ))
    .all();
  const committedByItem = new Map<string, number>();
  for (const row of existing) {
    const committed = row.status === "requested"
      ? row.requestedQuantity
      : row.status === "approved" || row.status === "receiving" || row.status === "completed"
        ? row.approvedQuantity
        : 0;
    committedByItem.set(
      row.orderItemId,
      (committedByItem.get(row.orderItemId) ?? 0) + committed,
    );
  }
  for (const line of input.lines) {
    const item = itemById.get(line.orderItemId)!;
    if ((committedByItem.get(line.orderItemId) ?? 0) + line.quantity > item.quantity) {
      throw new ValidationError("Return quantity exceeds the fulfilled quantity still eligible for return.", {
        orderItemId: line.orderItemId,
        fulfilledQuantity: item.quantity,
      });
    }
  }

  const baseResult: Omit<OrderReturnCommandResult, "wholeOrderReturned"> = {
    orderId,
    returnId,
    status: "requested",
    version: 1,
    restockedQuantity: 0,
  };
  const responsePayload = JSON.stringify({ ...baseResult, wholeOrderReturned: false });
  const activeClaim = db
    .select({ value: sql<number>`1` })
    .from(orderReturns)
    .where(and(eq(orderReturns.orderId, orderId), isNotNull(orderReturns.activeOrderKey)));
  const guardedHeaderInsert = db.insert(orderReturns).select(
    db.select({
      id: sql<string>`${returnId}`.as("id"),
      orderId: orders.id,
      status: sql<OrderReturnStatus>`'requested'`.as("status"),
      reason: sql<string>`${input.reason}`.as("reason"),
      notes: sql<string | null>`${input.notes ?? null}`.as("notes"),
      actorType: sql<OrderReturnActor["type"]>`${actor.type}`.as("actor_type"),
      actorId: sql<string | null>`${actor.id ?? null}`.as("actor_id"),
      source: sql<OrderReturnSource>`${source}`.as("source"),
      sourceReferenceId: sql<string | null>`${options.sourceReferenceId ?? null}`.as("source_reference_id"),
      version: sql<number>`1`.as("version"),
      activeOrderKey: sql<string | null>`NULL`.as("active_order_key"),
      activeCommandKey: sql<string | null>`NULL`.as("active_command_key"),
      activeCommandHash: sql<string | null>`NULL`.as("active_command_hash"),
      activeCommandType: sql<string | null>`NULL`.as("active_command_type"),
      activeCommandStartedAt: sql<number | null>`NULL`.as("active_command_started_at"),
      requestedAt: sql<Date>`unixepoch()`.as("requested_at"),
      approvedAt: sql<Date | null>`NULL`.as("approved_at"),
      receivingStartedAt: sql<Date | null>`NULL`.as("receiving_started_at"),
      completedAt: sql<Date | null>`NULL`.as("completed_at"),
      rejectedAt: sql<Date | null>`NULL`.as("rejected_at"),
      cancelledAt: sql<Date | null>`NULL`.as("cancelled_at"),
      createdAt: sql<Date>`unixepoch()`.as("created_at"),
      updatedAt: sql<Date>`unixepoch()`.as("updated_at"),
    })
      .from(orders)
      .where(and(
        eq(orders.id, orderId),
        eq(orders.version, input.expectedOrderVersion),
        notExists(activeClaim),
      )),
  ).returning({ id: orderReturns.id });
  const lineInserts = input.lines.map((line) => {
    const item = itemById.get(line.orderItemId)!;
    return db.insert(orderReturnLines).values({
      id: `rtl_${nanoid(20)}`,
      returnId,
      orderId,
      orderItemId: item.id,
      variantId: item.variantId,
      inventoryTracked: item.inventoryTracked,
      requestedQuantity: line.quantity,
      reason: line.reason ?? null,
      notes: line.notes ?? null,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    }).returning({ id: orderReturnLines.id });
  });
  const commandInsert = db.insert(orderReturnCommands).values({
    id: identity.commandId,
    orderId,
    returnId,
    commandKey: input.commandKey,
    commandType: "create",
    requestHash: identity.requestHash,
    status: "committed",
    responsePayload,
    actorType: actor.type,
    actorId: actor.id ?? null,
    createdAt: sql`unixepoch()`,
    updatedAt: sql`unixepoch()`,
  }).returning({ id: orderReturnCommands.id });
  const orderVersionUpdate = db.update(orders).set({
    version: input.expectedOrderVersion + 1,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(orders.id, orderId),
    eq(orders.version, input.expectedOrderVersion),
  )).returning({ id: orders.id });

  try {
    const results = await safeBatch(
      db,
      [guardedHeaderInsert, ...lineInserts, commandInsert, orderVersionUpdate] as never,
    ) as { id: string }[][];
    if (!results[0]?.length || !results.at(-1)?.length) {
      throw new ConflictError("Order changed while the return was being created. Reload and try again.");
    }
  } catch (error) {
    if (isConstraintError(error)) {
      const racedReplay = resolveReplay(
        await readCommandReplay(db, orderId, input.commandKey),
        identity.requestHash,
      );
      if (racedReplay) return resultWithOrderStatus(db, racedReplay);
      throw new ConflictError("Return quantity or command identity conflicted with another request.");
    }
    throw error;
  }
  return resultWithOrderStatus(db, baseResult);
}

async function loadReturnCommandContext(db: Database, orderId: string, returnId: string) {
  const header = await db
    .select({
      id: orderReturns.id,
      status: orderReturns.status,
      version: orderReturns.version,
      activeOrderKey: orderReturns.activeOrderKey,
      activeCommandKey: orderReturns.activeCommandKey,
      activeCommandHash: orderReturns.activeCommandHash,
    })
    .from(orderReturns)
    .where(and(eq(orderReturns.id, returnId), eq(orderReturns.orderId, orderId)))
    .get();
  if (!header) throw new NotFoundError("Order return not found");
  const order = await db
    .select({ status: orders.status, version: orders.version, inventoryPool: orders.inventoryPool })
    .from(orders)
    .where(eq(orders.id, orderId))
    .get();
  if (!order) throw new NotFoundError("Order not found");
  const lines = await db
    .select({
      id: orderReturnLines.id,
      orderItemId: orderReturnLines.orderItemId,
      variantId: orderReturnLines.variantId,
      inventoryTracked: orderReturnLines.inventoryTracked,
      requestedQuantity: orderReturnLines.requestedQuantity,
      approvedQuantity: orderReturnLines.approvedQuantity,
      receivedQuantity: orderReturnLines.receivedQuantity,
      restockQuantity: orderReturnLines.restockQuantity,
      damagedQuantity: orderReturnLines.damagedQuantity,
      rejectedQuantity: orderReturnLines.rejectedQuantity,
      notes: orderReturnLines.notes,
    })
    .from(orderReturnLines)
    .where(eq(orderReturnLines.returnId, returnId))
    .all();
  return { header, order, lines };
}

function commandExists(db: Database, commandId: string) {
  return db
    .select({ value: sql<number>`1` })
    .from(orderReturnCommands)
    .where(eq(orderReturnCommands.id, commandId));
}

export async function approveOrderReturn(
  db: Database,
  orderId: string,
  returnId: string,
  input: ApproveOrderReturnInput,
  actor: OrderReturnActor,
): Promise<OrderReturnCommandResult> {
  uniqueIds(input.lines.map((line) => line.lineId), "Approval lines");
  const identity = await buildCommandIdentity(orderId, returnId, "approve", input.commandKey, input);
  const replay = resolveReplay(await readCommandReplay(db, orderId, input.commandKey), identity.requestHash);
  if (replay) return resultWithOrderStatus(db, replay);
  const context = await loadReturnCommandContext(db, orderId, returnId);
  if (context.header.version !== input.expectedVersion) {
    throw new ConflictError("Return changed while approval was being prepared. Reload and try again.");
  }
  if (context.header.status !== "requested") {
    throw new ValidationError("Only a requested return can be approved or rejected.");
  }
  if (input.lines.length !== context.lines.length) {
    throw new ValidationError("Approval must decide every line in the return.");
  }
  const decisionById = new Map(input.lines.map((line) => [line.lineId, line]));
  let approvedTotal = 0;
  for (const line of context.lines) {
    const decision = decisionById.get(line.id);
    if (!decision) throw new ValidationError("Approval contains a line that does not belong to this return.");
    if (decision.approvedQuantity + decision.rejectedQuantity !== line.requestedQuantity) {
      throw new ValidationError("Approved and rejected quantities must decide every requested unit.", {
        lineId: line.id,
      });
    }
    approvedTotal += decision.approvedQuantity;
  }
  const nextStatus: OrderReturnStatus = approvedTotal > 0 ? "approved" : "rejected";
  const baseResult: Omit<OrderReturnCommandResult, "wholeOrderReturned"> = {
    orderId,
    returnId,
    status: nextStatus,
    version: input.expectedVersion + 1,
    restockedQuantity: 0,
  };
  const responsePayload = JSON.stringify({ ...baseResult, wholeOrderReturned: false });
  const activeClaim = db.select({ value: sql<number>`1` }).from(orderReturns).where(and(
    eq(orderReturns.orderId, orderId),
    isNotNull(orderReturns.activeOrderKey),
  ));
  const commandGuard = db.insert(orderReturnCommands).select(
    db.select({
      id: sql<string>`${identity.commandId}`.as("id"),
      orderId: orderReturns.orderId,
      returnId: orderReturns.id,
      commandKey: sql<string>`${input.commandKey}`.as("command_key"),
      commandType: sql<ReturnCommandType>`'approve'`.as("command_type"),
      requestHash: sql<string>`${identity.requestHash}`.as("request_hash"),
      requestPayload: sql<string | null>`NULL`.as("request_payload"),
      status: sql<string>`'committed'`.as("status"),
      responsePayload: sql<string>`${responsePayload}`.as("response_payload"),
      actorType: sql<OrderReturnActor["type"]>`${actor.type}`.as("actor_type"),
      actorId: sql<string | null>`${actor.id ?? null}`.as("actor_id"),
      createdAt: sql<Date>`unixepoch()`.as("created_at"),
      updatedAt: sql<Date>`unixepoch()`.as("updated_at"),
    })
      .from(orderReturns)
      .innerJoin(orders, eq(orders.id, orderReturns.orderId))
      .where(and(
        eq(orderReturns.id, returnId),
        eq(orderReturns.orderId, orderId),
        eq(orderReturns.status, "requested"),
        eq(orderReturns.version, input.expectedVersion),
        eq(orders.version, context.order.version),
        notExists(activeClaim),
      )),
  ).returning({ id: orderReturnCommands.id });
  const commandRecordExists = commandExists(db, identity.commandId);
  const lineUpdates = context.lines.map((line) => {
    const decision = decisionById.get(line.id)!;
    return db.update(orderReturnLines).set({
      approvedQuantity: decision.approvedQuantity,
      rejectedQuantity: decision.rejectedQuantity,
      notes: decision.notes ?? line.notes,
      updatedAt: sql`unixepoch()`,
    }).where(and(
      eq(orderReturnLines.id, line.id),
      eq(orderReturnLines.returnId, returnId),
      exists(commandRecordExists),
    )).returning({ id: orderReturnLines.id });
  });
  const headerUpdate = db.update(orderReturns).set({
    status: nextStatus,
    version: input.expectedVersion + 1,
    notes: input.notes ?? undefined,
    approvedAt: nextStatus === "approved" ? sql`unixepoch()` : null,
    rejectedAt: nextStatus === "rejected" ? sql`unixepoch()` : null,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(orderReturns.id, returnId),
    eq(orderReturns.version, input.expectedVersion),
    exists(commandRecordExists),
  )).returning({ id: orderReturns.id });
  const orderUpdate = db.update(orders).set({
    version: context.order.version + 1,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(orders.id, orderId),
    eq(orders.version, context.order.version),
    exists(commandRecordExists),
  )).returning({ id: orders.id });
  try {
    const results = await safeBatch(db, [commandGuard, ...lineUpdates, headerUpdate, orderUpdate] as never) as { id: string }[][];
    if (!results[0]?.length || !results.at(-1)?.length) {
      throw new ConflictError("Return changed while approval was being committed. Reload and try again.");
    }
  } catch (error) {
    if (isConstraintError(error)) {
      const racedReplay = resolveReplay(await readCommandReplay(db, orderId, input.commandKey), identity.requestHash);
      if (racedReplay) return resultWithOrderStatus(db, racedReplay);
    }
    throw error;
  }
  return resultWithOrderStatus(db, baseResult);
}

async function shouldMarkWholeOrderReturned(
  db: Database,
  orderId: string,
  returnId: string,
  nextReceivedByLineId: ReadonlyMap<string, number>,
): Promise<boolean> {
  const fulfilledItems = await db
    .select({ id: orderItems.id, quantity: orderItems.quantity })
    .from(orderItems)
    .where(and(
      eq(orderItems.orderId, orderId),
      inArray(orderItems.fulfillmentStatus, [ItemFulfillmentStatus.SHIPPED, ItemFulfillmentStatus.DELIVERED]),
    ))
    .all();
  if (fulfilledItems.length === 0) return false;
  const receivedRows = await db
    .select({
      returnId: orderReturnLines.returnId,
      lineId: orderReturnLines.id,
      orderItemId: orderReturnLines.orderItemId,
      receivedQuantity: orderReturnLines.receivedQuantity,
      status: orderReturns.status,
    })
    .from(orderReturnLines)
    .innerJoin(orderReturns, eq(orderReturns.id, orderReturnLines.returnId))
    .where(eq(orderReturnLines.orderId, orderId))
    .all();
  const receivedByItem = new Map<string, number>();
  for (const row of receivedRows) {
    if (row.status === "cancelled" || row.status === "rejected") continue;
    const received = row.returnId === returnId
      ? (nextReceivedByLineId.get(row.lineId) ?? row.receivedQuantity)
      : row.receivedQuantity;
    receivedByItem.set(
      row.orderItemId,
      (receivedByItem.get(row.orderItemId) ?? 0) + received,
    );
  }
  return fulfilledItems.every((item) => (receivedByItem.get(item.id) ?? 0) === item.quantity);
}

export async function receiveOrderReturn(
  db: Database,
  orderId: string,
  returnId: string,
  input: ReceiveOrderReturnInput,
  actor: OrderReturnActor,
): Promise<OrderReturnCommandResult> {
  uniqueIds(input.lines.map((line) => line.lineId), "Receipt lines");
  const identity = await buildCommandIdentity(orderId, returnId, "receive", input.commandKey, input);
  const existingCommand = await readCommandReplay(db, orderId, input.commandKey);
  if (existingCommand?.status === "committed") {
    return resultWithOrderStatus(db, resolveReplay(existingCommand, identity.requestHash)!);
  }
  if (existingCommand && existingCommand.requestHash !== identity.requestHash) {
    throw new ConflictError("Return command key was already used with a different payload.");
  }
  const receiptActor: OrderReturnActor = existingCommand
    ? { type: existingCommand.actorType, id: existingCommand.actorId }
    : actor;

  let context = await loadReturnCommandContext(db, orderId, returnId);
  if (context.header.version !== input.expectedVersion) {
    throw new ConflictError("Return changed while receipt was being prepared. Reload and try again.");
  }
  if (context.header.status !== "approved" && context.header.status !== "receiving") {
    throw new ValidationError("Only an approved or partially received return can receive items.");
  }
  const receiptById = new Map(input.lines.map((line) => [line.lineId, line]));
  for (const receipt of input.lines) {
    const line = context.lines.find((candidate) => candidate.id === receipt.lineId);
    if (!line) throw new ValidationError("Receipt contains a line that does not belong to this return.");
    if (receipt.receivedQuantity > line.approvedQuantity - line.receivedQuantity) {
      throw new ValidationError("Received quantity exceeds the approved quantity still outstanding.", {
        lineId: line.id,
      });
    }
    if (receipt.restockQuantity > 0 && (!line.inventoryTracked || !line.variantId)) {
      throw new ValidationError("This return line is not backed by a tracked sellable SKU and cannot be restocked.", {
        lineId: line.id,
      });
    }
  }

  if (!existingCommand) {
    const activeClaim = db.select({ value: sql<number>`1` }).from(orderReturns).where(and(
      eq(orderReturns.orderId, orderId),
      isNotNull(orderReturns.activeOrderKey),
    ));
    const commandClaim = db.insert(orderReturnCommands).select(
      db.select({
        id: sql<string>`${identity.commandId}`.as("id"),
        orderId: orderReturns.orderId,
        returnId: orderReturns.id,
        commandKey: sql<string>`${input.commandKey}`.as("command_key"),
        commandType: sql<ReturnCommandType>`'receive'`.as("command_type"),
        requestHash: sql<string>`${identity.requestHash}`.as("request_hash"),
        requestPayload: sql<string>`${stableStringify(input)}`.as("request_payload"),
        status: sql<string>`'processing'`.as("status"),
        responsePayload: sql<string | null>`NULL`.as("response_payload"),
        actorType: sql<OrderReturnActor["type"]>`${actor.type}`.as("actor_type"),
        actorId: sql<string | null>`${actor.id ?? null}`.as("actor_id"),
        createdAt: sql<Date>`unixepoch()`.as("created_at"),
        updatedAt: sql<Date>`unixepoch()`.as("updated_at"),
      })
        .from(orderReturns)
        .innerJoin(orders, eq(orders.id, orderReturns.orderId))
        .where(and(
          eq(orderReturns.id, returnId),
          eq(orderReturns.orderId, orderId),
          inArray(orderReturns.status, ["approved", "receiving"]),
          eq(orderReturns.version, input.expectedVersion),
          eq(orders.version, context.order.version),
          notExists(activeClaim),
        )),
    ).returning({ id: orderReturnCommands.id });
    const commandRecordExists = commandExists(db, identity.commandId);
    const headerClaim = db.update(orderReturns).set({
      activeOrderKey: orderId,
      activeCommandKey: input.commandKey,
      activeCommandHash: identity.requestHash,
      activeCommandType: "receive",
      activeCommandStartedAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    }).where(and(
      eq(orderReturns.id, returnId),
      eq(orderReturns.version, input.expectedVersion),
      exists(commandRecordExists),
    )).returning({ id: orderReturns.id });
    const orderClaim = db.update(orders).set({
      version: context.order.version + 1,
      updatedAt: sql`unixepoch()`,
    }).where(and(
      eq(orders.id, orderId),
      eq(orders.version, context.order.version),
      exists(commandRecordExists),
    )).returning({ id: orders.id });
    try {
      const claimResults = await safeBatch(db, [commandClaim, headerClaim, orderClaim] as never) as { id: string }[][];
      if (!claimResults.every((result) => result?.length)) {
        throw new ConflictError("Another return or order command won the receipt claim. Reload and try again.");
      }
    } catch (error) {
      if (isConstraintError(error)) {
        const raced = await readCommandReplay(db, orderId, input.commandKey);
        if (!raced || raced.requestHash !== identity.requestHash) {
          throw new ConflictError("Another return receipt is already in progress for this order.");
        }
      } else {
        throw error;
      }
    }
    context = await loadReturnCommandContext(db, orderId, returnId);
  } else if (
    context.header.activeCommandKey !== input.commandKey
    || context.header.activeCommandHash !== identity.requestHash
  ) {
    throw new ServiceUnavailableError(
      "Return receipt claim requires reconciliation. Retry the original command key.",
    );
  }

  const movementByLineId = new Map<string, string | null>();
  const inventoryPool = context.order.inventoryPool === "preorder"
    || context.order.inventoryPool === "backorder"
    ? context.order.inventoryPool
    : "regular";
  for (const line of context.lines) {
    const receipt = receiptById.get(line.id);
    if (!receipt || receipt.restockQuantity === 0) continue;
    const movementIds = await applyClaimedInventoryEntryBatch(db, {
      orderId,
      operation: "restore",
      entries: [{ variantId: line.variantId!, quantity: receipt.restockQuantity }],
      claimKey: `return-receipt:v1:${returnId}:${input.commandKey}:${line.id}`,
      pool: inventoryPool,
      createdBy: receiptActor.id ?? null,
    });
    movementByLineId.set(line.id, movementIds[0] ?? null);
  }

  const nextReceivedByLineId = new Map<string, number>();
  for (const line of context.lines) {
    const receipt = receiptById.get(line.id);
    nextReceivedByLineId.set(
      line.id,
      line.receivedQuantity + (receipt?.receivedQuantity ?? 0),
    );
  }
  const completed = context.lines.every(
    (line) => nextReceivedByLineId.get(line.id) === line.approvedQuantity,
  );
  const nextStatus: OrderReturnStatus = completed ? "completed" : "receiving";
  const wholeOrderReturned = completed && await shouldMarkWholeOrderReturned(
    db,
    orderId,
    returnId,
    nextReceivedByLineId,
  );
  const restockedQuantity = input.lines.reduce((total, line) => total + line.restockQuantity, 0);
  const baseResult: Omit<OrderReturnCommandResult, "wholeOrderReturned"> = {
    orderId,
    returnId,
    status: nextStatus,
    version: input.expectedVersion + 1,
    restockedQuantity,
  };
  const responsePayload = JSON.stringify({ ...baseResult, wholeOrderReturned });
  const activePredicate = and(
    eq(orderReturns.id, returnId),
    eq(orderReturns.version, input.expectedVersion),
    eq(orderReturns.activeCommandKey, input.commandKey),
    eq(orderReturns.activeCommandHash, identity.requestHash),
  );
  const receiptInserts = context.lines.flatMap((line) => {
    const receipt = receiptById.get(line.id);
    if (!receipt) return [];
    return [db.insert(orderReturnReceiptLines).select(
      db.select({
        id: sql<string>`${`rrl_${nanoid(20)}`}`.as("id"),
        commandId: orderReturnCommands.id,
        returnId: orderReturns.id,
        returnLineId: orderReturnLines.id,
        orderId: orderReturns.orderId,
        variantId: orderReturnLines.variantId,
        receivedQuantity: sql<number>`${receipt.receivedQuantity}`.as("received_quantity"),
        restockQuantity: sql<number>`${receipt.restockQuantity}`.as("restock_quantity"),
        damagedQuantity: sql<number>`${receipt.damagedQuantity}`.as("damaged_quantity"),
        actorType: sql<OrderReturnActor["type"]>`${receiptActor.type}`.as("actor_type"),
        actorId: sql<string | null>`${receiptActor.id ?? null}`.as("actor_id"),
        inventoryMovementId: sql<string | null>`${movementByLineId.get(line.id) ?? null}`.as("inventory_movement_id"),
        notes: sql<string | null>`${receipt.notes ?? null}`.as("notes"),
        createdAt: sql<Date>`unixepoch()`.as("created_at"),
      })
        .from(orderReturnLines)
        .innerJoin(orderReturns, eq(orderReturns.id, orderReturnLines.returnId))
        .innerJoin(orderReturnCommands, eq(orderReturnCommands.id, identity.commandId))
        .where(and(
          eq(orderReturnLines.id, line.id),
          eq(orderReturnLines.returnId, returnId),
          activePredicate,
          eq(orderReturnCommands.status, "processing"),
          eq(orderReturnCommands.requestHash, identity.requestHash),
        )),
    ).returning({ id: orderReturnReceiptLines.id })];
  });
  const headerFinalize = db.update(orderReturns).set({
    status: nextStatus,
    version: input.expectedVersion + 1,
    notes: input.notes ?? undefined,
    activeOrderKey: null,
    activeCommandKey: null,
    activeCommandHash: null,
    activeCommandType: null,
    activeCommandStartedAt: null,
    receivingStartedAt: context.header.status === "approved" ? sql`unixepoch()` : undefined,
    completedAt: completed ? sql`unixepoch()` : null,
    updatedAt: sql`unixepoch()`,
  }).where(activePredicate).returning({ id: orderReturns.id });
  const commandFinalize = db.update(orderReturnCommands).set({
    status: "committed",
    responsePayload,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(orderReturnCommands.id, identity.commandId),
    eq(orderReturnCommands.status, "processing"),
    eq(orderReturnCommands.requestHash, identity.requestHash),
  )).returning({ id: orderReturnCommands.id });
  const orderStatusFinalize = wholeOrderReturned
    ? db.update(orders).set({
        status: OrderStatus.RETURNED,
        version: context.order.version + 1,
        updatedAt: sql`unixepoch()`,
      }).where(and(
        eq(orders.id, orderId),
        eq(orders.version, context.order.version),
        inArray(orders.status, [OrderStatus.SHIPPED, OrderStatus.DELIVERED, OrderStatus.COMPLETED]),
      )).returning({ id: orders.id })
    : null;
  const finalQueries = [
    ...receiptInserts,
    headerFinalize,
    commandFinalize,
    ...(orderStatusFinalize ? [orderStatusFinalize] : []),
  ];
  const finalizeResults = await safeBatch(db, finalQueries as never) as { id: string }[][];
  const headerIndex = receiptInserts.length;
  const commandIndex = headerIndex + 1;
  if (
    finalizeResults.slice(0, receiptInserts.length).some((result) => !result?.length)
    || !finalizeResults[headerIndex]?.length
    || !finalizeResults[commandIndex]?.length
  ) {
    throw new ServiceUnavailableError(
      "Return stock was reconciled but receipt finalization requires retry with the same command key.",
    );
  }
  return resultWithOrderStatus(db, baseResult);
}

/**
 * Resume a claimed receipt from durable server state. This is intentionally
 * keyed by the return rather than a browser-held idempotency key: an operator
 * can recover after a lost response or page reload without re-entering a
 * disposition that may already have changed stock.
 */
export async function reconcileOrderReturnReceipt(
  db: Database,
  orderId: string,
  returnId: string,
): Promise<OrderReturnCommandResult> {
  const active = await db
    .select({
      commandKey: orderReturns.activeCommandKey,
      commandHash: orderReturns.activeCommandHash,
    })
    .from(orderReturns)
    .where(and(eq(orderReturns.id, returnId), eq(orderReturns.orderId, orderId)))
    .get();
  if (!active) throw new NotFoundError("Order return not found");
  if (!active.commandKey || !active.commandHash) {
    throw new ValidationError("This return has no receipt reconciliation in progress.");
  }

  const command = await db
    .select({
      requestHash: orderReturnCommands.requestHash,
      requestPayload: orderReturnCommands.requestPayload,
      status: orderReturnCommands.status,
      responsePayload: orderReturnCommands.responsePayload,
      actorType: orderReturnCommands.actorType,
      actorId: orderReturnCommands.actorId,
    })
    .from(orderReturnCommands)
    .where(and(
      eq(orderReturnCommands.orderId, orderId),
      eq(orderReturnCommands.returnId, returnId),
      eq(orderReturnCommands.commandKey, active.commandKey),
      eq(orderReturnCommands.commandType, "receive"),
    ))
    .get();
  if (!command || command.requestHash !== active.commandHash) {
    throw new ServiceUnavailableError(
      "Return receipt recovery evidence is incomplete and requires manual reconciliation.",
    );
  }
  if (command.status === "committed") {
    return resultWithOrderStatus(db, parseCommandResult(command.responsePayload));
  }
  if (!command.requestPayload) {
    throw new ServiceUnavailableError(
      "Return receipt recovery payload is missing and requires manual reconciliation.",
    );
  }

  let rawInput: unknown;
  try {
    rawInput = JSON.parse(command.requestPayload);
  } catch {
    throw new ServiceUnavailableError(
      "Return receipt recovery payload is unreadable and requires manual reconciliation.",
    );
  }
  const parsed = receiveOrderReturnSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ServiceUnavailableError(
      "Return receipt recovery payload is invalid and requires manual reconciliation.",
    );
  }
  return receiveOrderReturn(db, orderId, returnId, parsed.data, {
    type: command.actorType,
    id: command.actorId,
  });
}

export async function cancelOrderReturn(
  db: Database,
  orderId: string,
  returnId: string,
  input: CancelOrderReturnInput,
  actor: OrderReturnActor,
): Promise<OrderReturnCommandResult> {
  const identity = await buildCommandIdentity(orderId, returnId, "cancel", input.commandKey, input);
  const replay = resolveReplay(await readCommandReplay(db, orderId, input.commandKey), identity.requestHash);
  if (replay) return resultWithOrderStatus(db, replay);
  const context = await loadReturnCommandContext(db, orderId, returnId);
  if (context.header.version !== input.expectedVersion) {
    throw new ConflictError("Return changed while cancellation was being prepared. Reload and try again.");
  }
  if (context.header.status !== "requested" && context.header.status !== "approved") {
    throw new ValidationError("Only an unreceived requested or approved return can be cancelled.");
  }
  if (context.lines.some((line) => line.receivedQuantity > 0)) {
    throw new ValidationError("A return with received inventory cannot be cancelled.");
  }
  const baseResult: Omit<OrderReturnCommandResult, "wholeOrderReturned"> = {
    orderId,
    returnId,
    status: "cancelled",
    version: input.expectedVersion + 1,
    restockedQuantity: 0,
  };
  const responsePayload = JSON.stringify({ ...baseResult, wholeOrderReturned: false });
  const commandGuard = db.insert(orderReturnCommands).select(
    db.select({
      id: sql<string>`${identity.commandId}`.as("id"),
      orderId: orderReturns.orderId,
      returnId: orderReturns.id,
      commandKey: sql<string>`${input.commandKey}`.as("command_key"),
      commandType: sql<ReturnCommandType>`'cancel'`.as("command_type"),
      requestHash: sql<string>`${identity.requestHash}`.as("request_hash"),
      requestPayload: sql<string | null>`NULL`.as("request_payload"),
      status: sql<string>`'committed'`.as("status"),
      responsePayload: sql<string>`${responsePayload}`.as("response_payload"),
      actorType: sql<OrderReturnActor["type"]>`${actor.type}`.as("actor_type"),
      actorId: sql<string | null>`${actor.id ?? null}`.as("actor_id"),
      createdAt: sql<Date>`unixepoch()`.as("created_at"),
      updatedAt: sql<Date>`unixepoch()`.as("updated_at"),
    }).from(orderReturns).innerJoin(orders, eq(orders.id, orderReturns.orderId)).where(and(
      eq(orderReturns.id, returnId),
      eq(orderReturns.orderId, orderId),
      inArray(orderReturns.status, ["requested", "approved"]),
      eq(orderReturns.version, input.expectedVersion),
      eq(orders.version, context.order.version),
      sql`NOT EXISTS (SELECT 1 FROM ${orderReturnLines} WHERE ${orderReturnLines.returnId} = ${returnId} AND ${orderReturnLines.receivedQuantity} > 0)`,
      notExists(db.select({ value: sql<number>`1` }).from(orderReturns).where(and(
        eq(orderReturns.orderId, orderId),
        isNotNull(orderReturns.activeOrderKey),
      ))),
    )),
  ).returning({ id: orderReturnCommands.id });
  const commandRecordExists = commandExists(db, identity.commandId);
  const headerUpdate = db.update(orderReturns).set({
    status: "cancelled",
    version: input.expectedVersion + 1,
    notes: input.notes ?? undefined,
    cancelledAt: sql`unixepoch()`,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(orderReturns.id, returnId),
    eq(orderReturns.version, input.expectedVersion),
    exists(commandRecordExists),
  )).returning({ id: orderReturns.id });
  const orderUpdate = db.update(orders).set({
    version: context.order.version + 1,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(orders.id, orderId),
    eq(orders.version, context.order.version),
    exists(commandRecordExists),
  )).returning({ id: orders.id });
  const results = await safeBatch(db, [commandGuard, headerUpdate, orderUpdate] as never) as { id: string }[][];
  if (!results.every((result) => result?.length)) {
    throw new ConflictError("Return changed while cancellation was being committed. Reload and try again.");
  }
  return resultWithOrderStatus(db, baseResult);
}

export async function assertOrderItemsHaveNoReturnHistory(
  db: Database,
  orderId: string,
): Promise<void> {
  const row = await db
    .select({ id: orderReturns.id, status: orderReturns.status })
    .from(orderReturns)
    .where(eq(orderReturns.orderId, orderId))
    .get();
  if (row) {
    throw new ConflictError(
      "Order items cannot be replaced or permanently deleted after a return record exists.",
    );
  }
}

export async function assertNoActiveReturnReceipt(
  db: Database,
  orderId: string,
): Promise<void> {
  const row = await db
    .select({ id: orderReturns.id, commandKey: orderReturns.activeCommandKey })
    .from(orderReturns)
    .where(and(eq(orderReturns.orderId, orderId), isNotNull(orderReturns.activeOrderKey)))
    .get();
  if (row) {
    throw new ConflictError(
      "A return receipt is being reconciled. Retry the order action after it completes.",
    );
  }
}
