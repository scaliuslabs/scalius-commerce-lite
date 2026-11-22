// The purchase order and supplier lifecycles, declared once for the server,
// the dashboard and apps: every status write names its move's source states,
// and every read of "still expected" uses the open set from here. The
// database CHECKs (`@scalius/database/schema` purchasing.ts) allow these states.
import { defineMachine } from "./machine";

export const PURCHASE_ORDER_STATUSES = ["draft", "ordered", "partially_received", "received", "cancelled"] as const;
export const SUPPLIER_STATUSES = ["active", "archived"] as const;

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
