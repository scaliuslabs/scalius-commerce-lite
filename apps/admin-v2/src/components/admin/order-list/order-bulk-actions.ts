import { isOrderArchiveStatusEligible } from "@scalius/core/modules/orders/browser";
import type { OrderActionBlock, OrderAdminActions } from "@scalius/shared/order-admin-actions";
import { listedActions } from "~/components/admin/orderview/order-actions";

/** confirm: bulk Confirm · send: own courier "Mark as sent" · ship: book a courier · archive. */
export type OrderBulkAction = "confirm" | "send" | "ship" | "archive";
export type OrderBlockReason = "refund" | "shipment" | "paymentSetup" | "hold";

/** A list row or the order page's order: the work-in-progress facts may be missing. */
interface PlannableOrder {
  status: string;
  actions?: OrderAdminActions | null;
  activeRefundOperation?: { active: boolean; locksOrder?: boolean } | null;
  paymentRecovery?: { state: string; activeProcessing?: boolean } | null;
  shipmentRecovery?: { activeLock?: boolean } | null;
}

/** The server's block reasons a bulk dialog words as work in progress on the order. */
const BLOCK_REASONS: Partial<Record<OrderActionBlock, OrderBlockReason>> = {
  refund_in_progress: "refund",
  courier_check: "shipment",
  payment_in_progress: "paymentSetup",
  on_hold: "hold",
};

/** Why one order is left out: its status (e.g. "cancelled") or work in progress on it. */
export type OrderSkip = { kind: "status"; status: string } | { kind: "block"; reason: OrderBlockReason };

function skipFor(order: PlannableOrder, reason: OrderActionBlock | null): OrderSkip {
  const block = reason ? BLOCK_REASONS[reason] : undefined;
  return block ? { kind: "block", reason: block } : { kind: "status", status: order.status };
}

/** Archiving is not an order action the server lists: finished orders, with nothing running on them. */
const ARCHIVE_BLOCKS: Array<[OrderBlockReason, (order: PlannableOrder) => boolean]> = [
  // Archiving waits for a refund that locks the order, not one its provider is completing.
  ["refund", (order) => order.activeRefundOperation?.active === true && order.activeRefundOperation.locksOrder !== false],
  ["shipment", (order) => order.shipmentRecovery?.activeLock === true],
  ["paymentSetup", (order) => order.paymentRecovery?.activeProcessing === true],
];

/**
 * Whether the bulk action runs on the order, by the actions the server listed
 * with it: Confirm by its Confirmed move, sending and booking by its Send (for
 * confirmed orders, as the bulk commands take only those).
 */
export function orderSkipReason(order: PlannableOrder, action: OrderBulkAction): OrderSkip | null {
  if (action === "archive") {
    if (!isOrderArchiveStatusEligible(order.status)) return { kind: "status", status: order.status };
    const blocked = ARCHIVE_BLOCKS.find(([, isBlocked]) => isBlocked(order));
    return blocked ? { kind: "block", reason: blocked[0] } : null;
  }
  const actions = listedActions(order);
  if (action === "confirm") {
    const move = actions.moves.find((candidate) => candidate.status === "confirmed");
    if (!move) return { kind: "status", status: order.status };
    return move.available ? null : skipFor(order, move.reason);
  }
  if (order.status.toLowerCase() !== "confirmed") return { kind: "status", status: order.status };
  return actions.send.available ? null : skipFor(order, actions.send.reason);
}

export interface OrderBulkPlan<T> {
  eligible: T[];
  /** Skipped orders grouped by reason, largest group first. */
  skipped: Array<OrderSkip & { count: number }>;
}

/** Which selected orders the action will run on, and why the rest are skipped. */
export function planOrderBulkAction<T extends PlannableOrder>(
  orders: readonly T[],
  action: OrderBulkAction,
): OrderBulkPlan<T> {
  const eligible: T[] = [];
  const groups = new Map<string, OrderSkip & { count: number }>();
  for (const order of orders) {
    const skip = orderSkipReason(order, action);
    if (!skip) {
      eligible.push(order);
      continue;
    }
    const key = skip.kind === "status" ? `status:${skip.status}` : `block:${skip.reason}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { ...skip, count: 1 });
  }
  return { eligible, skipped: [...groups.values()].sort((a, b) => b.count - a.count) };
}

/** Bulk endpoints take at most 90 orders per request. */
export const BULK_REQUEST_MAX_ORDERS = 90;

/** Bulk endpoints take at most 90 orders per request. */
export function chunk<T>(items: readonly T[], size = BULK_REQUEST_MAX_ORDERS): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/** One per-row bulk request's answer: the orders it handled, and those it left for the next request. */
export interface BulkRequestResult {
  results: ReadonlyArray<{ orderId: string; success: boolean; error?: string | null }>;
  /** Absent from an API older than per-request plan sizes: it handled everything it was sent. */
  remaining?: readonly string[];
}

/** The orders the next request sends (at most 90), and the rest of the queue. */
export function nextBulkRequest(queue: readonly string[]): { sent: string[]; next: string[] } {
  return { sent: queue.slice(0, BULK_REQUEST_MAX_ORDERS), next: queue.slice(BULK_REQUEST_MAX_ORDERS) };
}

/**
 * The queue after a request: what the server left (`remaining`, a per-request
 * plan size) goes first, then the rest. Null when the request handled none of
 * what it was sent, so the run never asks for the same orders forever.
 */
export function queueAfterBulkResponse(
  sent: readonly string[],
  next: readonly string[],
  response: BulkRequestResult,
): string[] | null {
  const handled = new Set(response.results.map((result) => result.orderId));
  const asked = new Set(sent);
  const left = (response.remaining ?? []).filter((orderId) => asked.has(orderId) && !handled.has(orderId));
  if (handled.size === 0 && left.length > 0) return null;
  return [...left, ...next];
}

/** Orders a request was sent but answered neither in `results` nor in `remaining`: not done. */
export function unansweredBulkOrders(sent: readonly string[], response: BulkRequestResult): string[] {
  const answered = new Set([...response.results.map((result) => result.orderId), ...(response.remaining ?? [])]);
  return sent.filter((orderId) => !answered.has(orderId));
}

/** What a bulk run did: the orders it finished and a short plain reason for each one it couldn't. */
export interface OrderBulkOutcome {
  succeeded: string[];
  failures: Array<{ orderId: string; error: string }>;
}

export function summarizeBulkResults(
  results: ReadonlyArray<{ orderId: string; success: boolean; error?: string | null }>,
  fallbackError: string,
): OrderBulkOutcome {
  return {
    succeeded: results.filter((item) => item.success).map((item) => item.orderId),
    failures: results
      .filter((item) => !item.success)
      .map((item) => ({
        orderId: item.orderId,
        error: typeof item.error === "string" && item.error.trim()
          ? item.error.replace(/\s+/g, " ").slice(0, 160)
          : fallbackError,
      })),
  };
}

export type OrderRefreshPause = "selected" | "dialog" | "saving";

/** Background refresh must not move rows the merchant is selecting or acting on. */
export function getOrderRefreshPause(activity: {
  selectedCount: number;
  actionDialogOpen: boolean;
  mutationInFlight: boolean;
}): OrderRefreshPause | null {
  if (activity.selectedCount > 0) return "selected";
  if (activity.actionDialogOpen) return "dialog";
  if (activity.mutationInFlight) return "saving";
  return null;
}
