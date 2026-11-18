// A provider event's claim (`webhook_events`): payment events of every
// gateway and courier tracking events. The row is claimed `processing` under
// a fresh claim token (`claim_id`); only the attempt that holds that token
// records the outcome, so an attempt whose lease ran out and was taken over
// (by a provider redelivery or the payment drain) writes nothing late.
// Every write of `status` is one of the moves below (apps/api
// utils/webhook-idempotency.ts and the refund import).
import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { WEBHOOK_EVENT_STATUSES, webhookEvents } from "@scalius/database/schema";
import { defineMachine } from "@scalius/shared/machine";

export const WEBHOOK_EVENT_MACHINE = defineMachine({
  name: "provider event",
  states: WEBHOOK_EVENT_STATUSES,
  initial: ["processing"],
  final: ["processed"],
  moves: {
    /** A provider re-sends a failed event, or one whose attempt's lease ran out. */
    redeliver: { from: ["failed", "processing"], to: "processing" },
    /** The payment drain takes a retry that is due, or an attempt whose lease ran out. */
    retry: { from: ["retrying", "processing"], to: "processing" },
    /**
     * The attempt applied the event. From `failed` only for the attempt a
     * runner give-up overtook while it was still running: that give-up keeps
     * the attempt's claim, and every other `failed` row holds none.
     */
    process: { from: ["processing", "failed"], to: "processed" },
    /** The attempt failed for good (retries spent, a courier event, or its runner never finished). */
    fail: { from: ["processing"], to: "failed" },
    /** The attempt failed and is due again later, or waits parked behind a shipment claim or a refund. */
    wait: { from: ["processing"], to: "retrying" },
    escalate: { from: ["processing", "failed"], to: "manual_reconciliation" },
    /** The refund import finishes an event staff were to reconcile, or defers it again. */
    reconcile: { from: ["manual_reconciliation"], to: "processed" },
    defer: { from: ["manual_reconciliation"], to: "manual_reconciliation" },
  },
});

export type WebhookEventMove = keyof typeof WEBHOOK_EVENT_MACHINE.moves;

/** The claim an attempt holds: the row's id and its claim token. */
export interface WebhookEventClaimToken {
  id: string;
  claimId: string;
}

export function newWebhookEventClaimId(): string {
  return `whec_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** The row while `claim` still holds it. */
export function heldWebhookEvent(claim: WebhookEventClaimToken): SQL {
  return and(eq(webhookEvents.id, claim.id), eq(webhookEvents.claimId, claim.claimId))!;
}

/**
 * The update of one move: it changes the row only while the row is in one
 * of the move's source states and `where` holds. A finishing move clears the
 * claim token; a claim sets the new one in `set`.
 */
export function webhookEventMove(
  db: Database,
  move: WebhookEventMove,
  where: SQL | undefined,
  set: { [K in Exclude<keyof typeof webhookEvents.$inferInsert, "id" | "status">]?: (typeof webhookEvents.$inferInsert)[K] | SQL } = {},
) {
  const { from, to } = WEBHOOK_EVENT_MACHINE.moves[move];
  return db.update(webhookEvents)
    .set({ ...(to === "processing" ? {} : { claimId: null }), ...set, status: to })
    .where(and(inArray(webhookEvents.status, [...from]), where));
}
