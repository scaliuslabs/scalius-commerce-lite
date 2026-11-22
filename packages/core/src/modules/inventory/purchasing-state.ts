// The purchase order and supplier lifecycles: the purchase order's is
// declared once in @scalius/shared/record-lifecycles (its commands, the
// writers' WHERE, its refusals and the actions it is read with); every read
// of "still expected" uses the open set from here.
import { sql } from "drizzle-orm";
import { defineMachine } from "@scalius/shared/machine";
import { PURCHASE_ORDER_LIFECYCLE, PURCHASE_ORDER_MACHINE } from "@scalius/shared/record-lifecycles";
import { SUPPLIER_STATUSES } from "@scalius/database/schema";

export { PURCHASE_ORDER_LIFECYCLE, PURCHASE_ORDER_MACHINE };

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
