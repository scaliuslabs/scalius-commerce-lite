import { isOrderArchiveStatusEligible } from "@scalius/core/modules/orders/order-archive-policy";
import type { OrderListItem } from "@scalius/core/modules/orders/orders.types";
import type { postApiV1AdminOrdersBulkShip } from "@scalius/api-client/sdk";
import type { ApiResult } from "~/lib/api";

export type OrderBulkAction = "archive" | "ship";
export type OrderBlockReason =
  | "status"
  | "refund"
  | "shipment"
  | "paymentSetup"
  | "paymentRecovery";

type BlockableOrder = Pick<
  OrderListItem,
  "status" | "activeRefundOperation" | "paymentRecovery" | "shipmentRecovery"
>;

const IS_BLOCKED: Record<OrderBlockReason, (order: BlockableOrder) => boolean> = {
  status: (order) => !isOrderArchiveStatusEligible(order.status),
  refund: (order) => order.activeRefundOperation?.active === true,
  shipment: (order) => order.shipmentRecovery?.activeLock === true,
  paymentSetup: (order) => order.paymentRecovery?.activeProcessing === true,
  paymentRecovery: (order) =>
    order.paymentRecovery != null && order.paymentRecovery.state !== "none",
};

const CHECKS: Record<OrderBulkAction, readonly OrderBlockReason[]> = {
  archive: ["status", "refund", "shipment", "paymentSetup"],
  ship: ["paymentSetup", "paymentRecovery", "refund", "shipment"],
};

/** The first reason (and how many orders it affects) that stops this action, or null. */
export function findOrderActionBlock(
  orders: readonly BlockableOrder[],
  action: OrderBulkAction,
): { reason: OrderBlockReason; count: number } | null {
  for (const reason of CHECKS[action]) {
    const count = orders.filter(IS_BLOCKED[reason]).length;
    if (count > 0) return { reason, count };
  }
  return null;
}

export interface BulkShipResultSummary {
  totalProcessed: number;
  successCount: number;
  failureCount: number;
  failures: Array<{ orderId: string; error: string }>;
}

type BulkShipOrdersPayload = ApiResult<typeof postApiV1AdminOrdersBulkShip>;

function safeShipError(error: unknown, fallback: string): string {
  return typeof error === "string" && error.trim()
    ? error.replace(/\s+/g, " ").slice(0, 160)
    : fallback;
}

export function summarizeBulkShip(
  result: BulkShipOrdersPayload,
  fallbackError: string,
): BulkShipResultSummary {
  return {
    totalProcessed: result.totalProcessed,
    successCount: result.successCount,
    failureCount: result.failureCount,
    failures: result.results
      .filter((item) => !item.success)
      .map((item) => ({ orderId: item.orderId, error: safeShipError(item.error, fallbackError) })),
  };
}

export function failedBulkShipSummary(
  orderIds: readonly string[],
  error: string,
): BulkShipResultSummary {
  return {
    totalProcessed: orderIds.length,
    successCount: 0,
    failureCount: orderIds.length,
    failures: orderIds.map((orderId) => ({ orderId, error })),
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
