// The platform's declared state machines, and the same shape for a status
// field of an app's own records. An app asks a machine whether a move is
// legal before it calls the API (`ORDER_MACHINE.reaches(order.status,
// "cancelled")`), so it never keeps a copy of the platform's table; and it
// moves its own records only by a declared move, at the revision it read.
import { machineRefusal, type Machine, type MachineRefusal } from "@scalius/shared/machine";
import type { PluginObjectCollection } from "./context";

export {
  defineMachine,
  machineRefusal,
  movesByTarget,
  type AnyMachine,
  type Machine,
  type MachineMove,
  type MachineMoves,
  type MachineRefusal,
  type MachineSpec,
} from "@scalius/shared/machine";
/** The order's workflow states and their moves (`orders.set_status` refuses any other), and cash on delivery's collection. */
export { COD_MACHINE, COD_STATUSES, ORDER_MACHINE, type CodStatusValue, type OrderStatusValue } from "@scalius/shared/order-state";
/** A product review's moderation. */
export { REVIEW_MACHINE, REVIEW_STATUSES, type ReviewStatus } from "@scalius/shared/reviews";
/** A shipment's states: a courier's report moves an open one in any order, a settled one only by a declared correction, and the store holds one for staff with any other report. */
export {
  SETTLED_SHIPMENT_STATUSES,
  SHIPMENT_CORRECTIONS,
  SHIPMENT_MACHINE,
  type ShipmentActor,
  type ShipmentMove,
  type ShipmentStatus,
} from "@scalius/shared/shipment-state";
/** A payment record's machines: a charge, moved by its provider's events, and a refund record, moved with its refund. */
export {
  PAYMENT_MACHINE,
  REFUND_RECORD_MACHINE,
  type ChargeStatus,
  type PaymentMove,
  type RefundRecordMove,
  type RefundRecordStatus,
} from "@scalius/shared/payment-record-state";
/** A warranty claim: staff move it from any state to any other; apps read it. */
export { WARRANTY_CLAIM_MACHINE, type WarrantyClaimStatus } from "@scalius/shared/warranty";
/** An object record's publication: draft and published for a storefront-visible type, else active. */
export { OBJECT_RECORD_MACHINE, objectRecordStatuses } from "@scalius/shared/plugins/object-status";

/** What `moveRecordStatus` did. */
export type RecordStatusMove<S extends string> =
  /** Written at the revision it read: the move, or (already there) only the patch. */
  | { written: true; status: S; revision: number }
  /** Nothing written: no record (`status` null), or no declared move from its status (`refusal`). */
  | { written: false; status: string | null; refusal: MachineRefusal | null };

/** Read-check-write attempts before a conflict is reported (as `update` makes). */
const MOVE_ATTEMPTS = 8;

/**
 * Moves the status field of one of the app's records to `to`, only by a
 * declared move of `machine` from the status it reads, and only at the
 * revision it read: a write that lost a race is read again and checked
 * again, so a late answer never moves a record back. A record already at
 * `to` takes only `patch`. With `expectedRevision`, a record written since
 * fails with `object_conflict` instead.
 */
export async function moveRecordStatus<S extends string>(
  records: Pick<PluginObjectCollection, "getVersion" | "update">,
  id: string,
  machine: Machine<S>,
  to: S,
  options: { field?: string; patch?: Record<string, unknown>; expectedRevision?: number } = {},
): Promise<RecordStatusMove<S>> {
  const field = options.field ?? "status";
  for (let attempt = 1; ; attempt += 1) {
    const current = await records.getVersion(id);
    if (!current) return { written: false, status: null, refusal: null };
    const from = String(current.data[field] ?? "");
    if (from !== to && !machine.reaches(from, to)) {
      return { written: false, status: from, refusal: machineRefusal(machine, from, to) };
    }
    try {
      const written = await records.update(id, { ...options.patch, [field]: to }, { expectedRevision: options.expectedRevision ?? current.revision });
      return { written: true, status: to, revision: written.revision };
    } catch (error) {
      const conflict = (error as { code?: unknown } | null)?.code === "object_conflict";
      if (!conflict || options.expectedRevision !== undefined || attempt >= MOVE_ATTEMPTS) throw error;
    }
  }
}
