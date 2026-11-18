// The purchase order and supplier lifecycles, declared once: every status
// write names its move's source states, and every read of "still expected"
// uses the open set from here.
import { sql } from "drizzle-orm";
import { defineMachine } from "@scalius/shared/machine";
import { PURCHASE_ORDER_STATUSES, SUPPLIER_STATUSES } from "@scalius/database/schema";

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

/** Ordered and not yet fully received: its open lines are incoming stock, and its supplier stays active. */
export const PURCHASE_ORDER_OPEN_STATUSES = PURCHASE_ORDER_MACHINE.moves.receive_part.from;

/** The open set as an SQL list for raw subqueries (constant states, never input). */
export const PURCHASE_ORDER_OPEN_SQL = sql.raw(PURCHASE_ORDER_OPEN_STATUSES.map((status) => `'${status}'`).join(", "));

export const SUPPLIER_MACHINE = defineMachine({
  name: "supplier",
  states: SUPPLIER_STATUSES,
  initial: ["active"],
  final: [],
  moves: {
    // Refused while an open purchase order names the supplier (suppliers.ts).
    archive: { from: ["active"], to: "archived" },
    restore: { from: ["archived"], to: "active" },
  },
});
