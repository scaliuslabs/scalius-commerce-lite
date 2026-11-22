// A courier parcel's states, declared once with what each means: its tone on
// a badge, and whether the courier's part is over (`terminal`). Couriers
// report states in any order, so a shipment has no edge table (state-machines
// IMPLICIT); this table is its open and settled rule for every reader, and a
// state added to SHIPMENT_STATUSES does not compile until it has a row here.
import type { CourierShipmentStatus } from "./plugins/providers/courier";

export type ShipmentStatus = CourierShipmentStatus | "creating" | "processing" | "reconcile_required";

/** A state's tone on a badge, in the dashboard's tone names (`neutral` is no tone). */
export type StateTone = "success" | "info" | "warning" | "attention" | "critical" | "neutral";

export interface StateFacts {
  readonly tone: StateTone;
  /** No courier move is expected after it: delivered, returned, given up. */
  readonly terminal: boolean;
}

export const SHIPMENT_STATES: Readonly<Record<ShipmentStatus, StateFacts>> = {
  creating: { tone: "neutral", terminal: false },
  processing: { tone: "neutral", terminal: false },
  reconcile_required: { tone: "attention", terminal: false },
  pending: { tone: "info", terminal: false },
  pickup_assigned: { tone: "info", terminal: false },
  picked_up: { tone: "info", terminal: false },
  pickup_failed: { tone: "attention", terminal: false },
  in_transit: { tone: "info", terminal: false },
  out_for_delivery: { tone: "info", terminal: false },
  on_hold: { tone: "attention", terminal: false },
  delivery_failed: { tone: "critical", terminal: false },
  unknown: { tone: "neutral", terminal: false },
  delivered: { tone: "success", terminal: true },
  partial_delivered: { tone: "attention", terminal: true },
  returned: { tone: "warning", terminal: true },
  cancelled: { tone: "critical", terminal: true },
  failed: { tone: "critical", terminal: true },
};

/** The facts of a stored status (any case), or null for a word that is not a state. */
export function shipmentState(status: string | null | undefined): StateFacts | null {
  const key = (status ?? "").trim().toLowerCase();
  return Object.hasOwn(SHIPMENT_STATES, key) ? SHIPMENT_STATES[key as ShipmentStatus] : null;
}

/** The courier's part is over. A word that is not a state is still open: nothing says it ended. */
export function isSettledShipment(status: string | null | undefined): boolean {
  return shipmentState(status)?.terminal ?? false;
}
