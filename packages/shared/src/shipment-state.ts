// A shipment's states and their machine, declared once. Each state has its
// tone on a badge and whether the parcel is settled (the courier's part is
// over). Couriers report states in any order, so the machine is an open and
// settled rule rather than an edge table:
//
// - The courier's report (its answer to a booking, a tracking answer, a push,
//   or staff recording an own-courier parcel, where the store is its own
//   courier) may move an open shipment to any state it reports, in any order.
//   A settled shipment takes no report that moves it: a late `in_transit`
//   after `delivered` is refused and changes nothing. A report of the state
//   the shipment is already in is not a move; it only refreshes the courier's
//   words.
// - The store holds any shipment for staff (`reconcile_required`: a booking
//   whose outcome is unknown, an order or stock update that failed after the
//   courier's word). A held shipment takes no courier report; only staff's
//   resolution restores it to a courier state.
//
// The server writes a shipment's status only as a move of this machine
// (`shipmentMove` in core), so every writer (the courier push, the status
// refresh, booking, the fulfilment ledger, staff's delivery outcomes,
// reconciliation) obeys the same rule. A state added to SHIPMENT_STATUSES does
// not compile until it has a row here.
import { defineMachine, type MachineMove } from "./machine";
import { COURIER_SHIPMENT_STATUSES, type CourierShipmentStatus } from "./plugins/providers/courier";

/** The store's own booking states: the row before the courier answered, and a shipment held for staff. */
export const STORE_SHIPMENT_STATUSES = ["creating", "reconcile_required"] as const;

export type ShipmentStatus = CourierShipmentStatus | (typeof STORE_SHIPMENT_STATUSES)[number];

/** A state's tone on a badge, in the dashboard's tone names (`neutral` is no tone). */
export type StateTone = "success" | "info" | "warning" | "attention" | "critical" | "neutral";

export interface StateFacts {
  readonly tone: StateTone;
  /** Settled: delivered, returned or given up. No courier report moves it again. */
  readonly settled: boolean;
}

export const SHIPMENT_STATES: Readonly<Record<ShipmentStatus, StateFacts>> = {
  creating: { tone: "neutral", settled: false },
  reconcile_required: { tone: "attention", settled: false },
  pending: { tone: "info", settled: false },
  pickup_assigned: { tone: "info", settled: false },
  picked_up: { tone: "info", settled: false },
  pickup_failed: { tone: "attention", settled: false },
  in_transit: { tone: "info", settled: false },
  out_for_delivery: { tone: "info", settled: false },
  on_hold: { tone: "attention", settled: false },
  delivery_failed: { tone: "critical", settled: false },
  unknown: { tone: "neutral", settled: false },
  delivered: { tone: "success", settled: true },
  partial_delivered: { tone: "attention", settled: true },
  returned: { tone: "warning", settled: true },
  cancelled: { tone: "critical", settled: true },
  failed: { tone: "critical", settled: true },
};

/** Who moves a shipment: its courier (or staff for an own-courier parcel), or the store holding and restoring it. */
export type ShipmentActor = "courier" | "store";

/** The settled states: no courier report moves a shipment out of one. */
export const SETTLED_SHIPMENT_STATUSES = COURIER_SHIPMENT_STATUSES.filter((status) => SHIPMENT_STATES[status].settled);

/** The states a courier report may move: the open courier states and the booking still waiting for the courier's answer. */
const REPORTABLE: readonly ShipmentStatus[] = [
  "creating",
  ...COURIER_SHIPMENT_STATUSES.filter((status) => !SHIPMENT_STATES[status].settled),
];

/**
 * A move's name: a courier's report is named by the state it reports
 * (`delivered`); the store holds a shipment (`hold`) and restores a held one
 * to a courier state (`restore_delivered`).
 */
export type ShipmentMove = CourierShipmentStatus | "hold" | `restore_${CourierShipmentStatus}`;

const moves = {} as Record<ShipmentMove, MachineMove<ShipmentStatus>>;
for (const to of COURIER_SHIPMENT_STATUSES) {
  // A report of the state the shipment is in names it among the sources: it refreshes the courier's words.
  moves[to] = { from: REPORTABLE.includes(to) ? REPORTABLE : [...REPORTABLE, to], to, by: ["courier"] };
}
moves.hold = { from: Object.keys(SHIPMENT_STATES) as ShipmentStatus[], to: "reconcile_required", by: ["store"] };
for (const to of COURIER_SHIPMENT_STATUSES) moves[`restore_${to}`] = { from: ["reconcile_required"], to, by: ["store"] };

export const SHIPMENT_MACHINE = defineMachine<ShipmentStatus, Record<ShipmentMove, MachineMove<ShipmentStatus>>>({
  name: "shipment",
  states: Object.keys(SHIPMENT_STATES) as ShipmentStatus[],
  // A courier booking starts `creating` (its row is written before the courier
  // is called); an own-courier parcel starts `in_transit`, handed over.
  initial: ["creating", "in_transit"],
  // The store may hold any shipment for staff, so no state is final; a settled
  // one only leaves for that hold, and comes back to a courier state.
  final: [],
  moves,
});

/** The move that writes `to` for `by`, or null when no move of that actor reaches it. */
export function shipmentMoveTo(to: string, by: ShipmentActor): ShipmentMove | null {
  const name = by === "courier" ? to : to === "reconcile_required" ? "hold" : `restore_${to}`;
  const move = SHIPMENT_MACHINE.moves[name as ShipmentMove];
  return move && move.by?.includes(by) ? name as ShipmentMove : null;
}

/** Whether `by` may write `to` over a shipment in `from`: a declared move, or a report of the state it is in. */
export function canWriteShipmentStatus(from: string, to: string, by: ShipmentActor): boolean {
  const move = shipmentMoveTo(to, by);
  return move !== null && SHIPMENT_MACHINE.can(from, move, by);
}

/** The facts of a stored status (any case), or null for a word that is not a state. */
export function shipmentState(status: string | null | undefined): StateFacts | null {
  const key = (status ?? "").trim().toLowerCase();
  return Object.hasOwn(SHIPMENT_STATES, key) ? SHIPMENT_STATES[key as ShipmentStatus] : null;
}

/** The courier's part is over. A word that is not a state is still open: nothing says it ended. */
export function isSettledShipment(status: string | null | undefined): boolean {
  return shipmentState(status)?.settled ?? false;
}

/** Whether `value` is a state a courier reports (the courier port's list). */
export function isCourierShipmentStatus(value: string | null | undefined): value is CourierShipmentStatus {
  return (COURIER_SHIPMENT_STATUSES as readonly string[]).includes(value ?? "");
}
