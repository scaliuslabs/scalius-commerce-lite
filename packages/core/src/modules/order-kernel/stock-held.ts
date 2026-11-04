/**
 * Why a cancelled order still holds its stock (a `stock_held` timeline
 * line's `data.reason`): the location is short of the units, the stock moved
 * while the release was written, or another refusal. Staff put it back from
 * the order once the cause is fixed.
 */
export const STOCK_HELD_REASONS = ["location_short", "stock_changed", "refused"] as const;
export type StockHeldReason = (typeof STOCK_HELD_REASONS)[number];
