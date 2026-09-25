// Owned by B4 (gift cards): "Refund to: Original payment / Store credit (gift card)" in the refund dialog; nothing until B4 ships it.
import type { Order } from "./types";

export type RefundSettlement = "original" | "store_credit";

export function RefundSettlementField(_props: {
  order: Order;
  value: RefundSettlement;
  onChange: (value: RefundSettlement) => void;
}): null {
  return null;
}

/** The refund request's settlement fields; none until B4 sends `settlement`. */
export function refundSettlementBody(_settlement: RefundSettlement): Record<never, never> {
  return {};
}
