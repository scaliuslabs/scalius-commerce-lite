// The order's actions as the server lists them with every read
// (@scalius/shared/order-admin-actions). The dashboard keeps no rule of its
// own about what an order allows: it shows, blocks and words these.
import type { OrderActionBlock, OrderActionState, OrderAdminActions } from "@scalius/shared/order-admin-actions";

const NONE: OrderActionState = { available: false, reason: "status" };
const NO_ACTIONS: OrderAdminActions = {
  moves: [],
  handOver: NONE,
  deliver: NONE,
  cod: { collect: NONE, fail: NONE, return: NONE },
  refund: NONE,
  next: null,
};

/** The order's actions; a read without them offers nothing. */
export function listedActions(order: { actions?: OrderAdminActions | null }): OrderAdminActions {
  return order.actions ?? NO_ACTIONS;
}

/** Work in progress or an archive: the action shows, disabled, until it passes. A hold hides it (the hold card says why). */
const PASSING_BLOCKS = new Set<OrderActionBlock>(["archived", "refund_in_progress", "courier_check", "payment_in_progress"]);

/** Shown on its card: available, or blocked only for now. An action the order's status rules out is not shown. */
export function isOffered(state: OrderActionState): boolean {
  return state.available || (state.reason !== null && PASSING_BLOCKS.has(state.reason));
}

/** The reason every status move shares when one lock stops them all (a refund, a courier check): the menu is then a fact. */
export function statusLock(actions: OrderAdminActions): OrderActionBlock | null {
  const first = actions.moves[0]?.reason ?? null;
  return first && PASSING_BLOCKS.has(first) && actions.moves.every((move) => move.reason === first) ? first : null;
}
