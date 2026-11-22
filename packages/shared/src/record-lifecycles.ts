// The lifecycles of the stock and returns records an agent or staff member
// moves by command: an item return, a purchase order and a transfer between
// locations. Each is declared once (its machine and the commands over it);
// the server's writers name a command's source states in their WHERE, refuse
// by it with the commands open instead, and read each record with its
// actions from the pure function here, so a listed action is one the server
// takes and a blocked one is one it refuses.
import { defineMachine } from "./machine";
import { defineRecordLifecycle, recordActions, type RecordActionState } from "./record-commands";
import { RETURN_STATUSES } from "./resource-states";

// ─── Item returns ──────────────────────────────────────────────────────

export const RETURN_MACHINE = defineMachine({
  name: "return",
  states: RETURN_STATUSES,
  initial: ["requested"],
  final: ["completed", "rejected", "cancelled"],
  moves: {
    approve: { from: ["requested"], to: "approved" },
    // An approval that approves no unit.
    reject: { from: ["requested"], to: "rejected" },
    receive_part: { from: ["approved", "receiving"], to: "receiving" },
    receive_all: { from: ["approved", "receiving"], to: "completed" },
    // Only before any unit is received.
    cancel: { from: ["requested", "approved"], to: "cancelled" },
  },
});

/** A return's commands (`dashboard.orders.return_<command>`, `dashboard.resources.returns.<command>`). */
export const RETURN_LIFECYCLE = defineRecordLifecycle(RETURN_MACHINE, {
  approve: { moves: ["approve", "reject"] },
  receive: { moves: ["receive_part", "receive_all"] },
  cancel: { moves: ["cancel"] },
});

export type ReturnCommand = keyof typeof RETURN_LIFECYCLE.commands;

/** Why a return command waits: a receipt on the order is being finished, or there is none to finish. */
export const RETURN_ACTION_BLOCKS = ["receipt_in_progress", "nothing_to_reconcile"] as const;
export type ReturnActionBlock = (typeof RETURN_ACTION_BLOCKS)[number];

export interface ReturnActionFacts {
  status: string;
  /** A receipt on one of the order's returns was claimed and not finished: every return command on the order waits for it. */
  orderReceiptClaimed: boolean;
  /** This return's own receipt is the claimed one. */
  receiptClaimed: boolean;
}

export type ReturnActions = Record<ReturnCommand, RecordActionState<ReturnActionBlock>> & {
  /** Finish this return's claimed receipt from the server's record of it (`dashboard.orders.return_reconcile`). */
  reconcile: RecordActionState<ReturnActionBlock>;
};

export function returnActions(facts: ReturnActionFacts): ReturnActions {
  const claimed: ReturnActionBlock | null = facts.orderReceiptClaimed || facts.receiptClaimed ? "receipt_in_progress" : null;
  const blocks: Partial<Record<ReturnCommand, ReturnActionBlock | null>> = {
    approve: claimed,
    receive: claimed,
    // Units received move a return to receiving, which no cancel leaves: the state alone refuses it.
    cancel: claimed,
  };
  return {
    ...recordActions(RETURN_LIFECYCLE, facts.status, blocks),
    reconcile: facts.receiptClaimed ? { available: true, reason: null } : { available: false, reason: "nothing_to_reconcile" },
  };
}

// ─── Purchase orders ───────────────────────────────────────────────────

/** A purchase order's states (`purchase_orders.status`, which declares the same list). */
export const PURCHASE_ORDER_STATUSES = ["draft", "ordered", "partially_received", "received", "cancelled"] as const;

export const PURCHASE_ORDER_MACHINE = defineMachine({
  name: "purchase order",
  states: PURCHASE_ORDER_STATUSES,
  initial: ["draft"],
  final: ["received", "cancelled"],
  moves: {
    order: { from: ["draft"], to: "ordered" },
    receive_part: { from: ["ordered", "partially_received"], to: "partially_received" },
    receive_all: { from: ["ordered", "partially_received"], to: "received" },
    // Received units stay in stock; only the rest stops coming.
    cancel: { from: ["draft", "ordered", "partially_received"], to: "cancelled" },
  },
});

/** A purchase order's commands (`dashboard.purchase_orders.<command>`). Edits and deletes move nothing: they name their states. */
export const PURCHASE_ORDER_LIFECYCLE = defineRecordLifecycle(PURCHASE_ORDER_MACHINE, {
  // A draft takes any change; an ordered one only its supplier, dates, notes and costs.
  update: { in: ["draft", "ordered", "partially_received"] },
  mark_ordered: { moves: ["order"] },
  receive: { moves: ["receive_part", "receive_all"] },
  cancel: { moves: ["cancel"] },
  // An ordered one is cancelled instead, keeping its history.
  delete: { in: ["draft"] },
});

export type PurchaseOrderCommand = keyof typeof PURCHASE_ORDER_LIFECYCLE.commands;

export const STOCK_DOCUMENT_ACTION_BLOCKS = ["no_lines", "location_archived", "supplier_archived", "nothing_in_transit", "stock_short", "sku_retired"] as const;
export type StockDocumentActionBlock = (typeof STOCK_DOCUMENT_ACTION_BLOCKS)[number];

export interface PurchaseOrderActionFacts {
  status: string;
  lineCount: number;
  /** Lines still to receive whose SKU is live (a retired SKU's line is not received). */
  openLiveLines: number;
  /** The destination location takes stock (not archived). */
  destinationActive: boolean;
  /** The supplier is active, or none is named. */
  supplierActive: boolean;
}

export type PurchaseOrderActions = Record<PurchaseOrderCommand, RecordActionState<StockDocumentActionBlock>>;

export function purchaseOrderActions(facts: PurchaseOrderActionFacts): PurchaseOrderActions {
  const location: StockDocumentActionBlock | null = facts.destinationActive ? null : "location_archived";
  const blocks: Partial<Record<PurchaseOrderCommand, StockDocumentActionBlock | null>> = {
    mark_ordered: facts.lineCount === 0 ? "no_lines" : location ?? (facts.supplierActive ? null : "supplier_archived"),
    receive: location ?? (facts.openLiveLines > 0 ? null : "sku_retired"),
  };
  return recordActions(PURCHASE_ORDER_LIFECYCLE, facts.status, blocks);
}

// ─── Transfers between locations ───────────────────────────────────────

/** A transfer's states (`inventory_transfers.status`, which declares the same list). */
export const INVENTORY_TRANSFER_STATUSES = ["draft", "in_transit", "partially_received", "received", "cancelled"] as const;

export const INVENTORY_TRANSFER_MACHINE = defineMachine({
  name: "transfer",
  states: INVENTORY_TRANSFER_STATUSES,
  initial: ["draft"],
  final: ["received", "cancelled"],
  moves: {
    ship: { from: ["draft"], to: "in_transit" },
    receive_part: { from: ["in_transit", "partially_received"], to: "partially_received" },
    receive_all: { from: ["in_transit", "partially_received"], to: "received" },
    // A draft just closes; units still on the road go back to the origin.
    cancel: { from: ["draft", "in_transit", "partially_received"], to: "cancelled" },
  },
});

/** A transfer's commands (`dashboard.inventory_transfers.<command>`). */
export const INVENTORY_TRANSFER_LIFECYCLE = defineRecordLifecycle(INVENTORY_TRANSFER_MACHINE, {
  update: { in: ["draft"] },
  ship: { moves: ["ship"] },
  receive: { moves: ["receive_part", "receive_all"] },
  cancel: { moves: ["cancel"] },
  delete: { in: ["draft"] },
});

export type InventoryTransferCommand = keyof typeof INVENTORY_TRANSFER_LIFECYCLE.commands;

export interface InventoryTransferActionFacts {
  status: string;
  lineCount: number;
  /** Lines a shipment would refuse now: the origin holds too few units, they are committed to orders, or the SKU was retired. */
  linesShort: number;
  /** Shipped units not yet received or returned. */
  inTransitQuantity: number;
  originActive: boolean;
  destinationActive: boolean;
}

export type InventoryTransferActions = Record<InventoryTransferCommand, RecordActionState<StockDocumentActionBlock>>;

export function inventoryTransferActions(facts: InventoryTransferActionFacts): InventoryTransferActions {
  const shipped = facts.status !== "draft";
  const nothingInTransit: StockDocumentActionBlock | null = facts.inTransitQuantity <= 0 ? "nothing_in_transit" : null;
  const blocks: Partial<Record<InventoryTransferCommand, StockDocumentActionBlock | null>> = {
    ship: facts.lineCount === 0 ? "no_lines"
      : !(facts.originActive && facts.destinationActive) ? "location_archived"
      : facts.linesShort > 0 ? "stock_short" : null,
    receive: facts.destinationActive ? nothingInTransit : "location_archived",
    cancel: shipped ? (facts.originActive ? nothingInTransit : "location_archived") : null,
  };
  return recordActions(INVENTORY_TRANSFER_LIFECYCLE, facts.status, blocks);
}
