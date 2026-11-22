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
