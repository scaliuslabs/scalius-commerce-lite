// The lifecycle of one refund attempt (`refund_attempts.status`). Every write
// of the column is a move of this machine (`refundAttemptMove`): its UPDATE
// names the move's source states, so a writer that lost a race to another
// (the request, reconciliation, staff's check, an import, a provider's later
// word) changes nothing. The in-flight states are the ones not settled; the
// database stores the same set (IN_FLIGHT_REFUND_ATTEMPT_STATUSES, in the
// single-flight index and the dispute requeue trigger; refund-attempt-machine.test.ts).
import { and, inArray, sql, type SQL } from "drizzle-orm";
import { defineMachine } from "@scalius/shared/machine";
import { refundAttempts } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";

export const REFUND_ATTEMPT_STATUSES = ["pending", "processing", "provider_unknown", "provider_processing", "reconcile_required", "refunded", "failed"] as const;
export type RefundAttemptStatus = (typeof REFUND_ATTEMPT_STATUSES)[number];

export const REFUND_ATTEMPT_MACHINE = defineMachine({
    name: "refund attempt",
    states: REFUND_ATTEMPT_STATUSES,
    // A provider refund starts pending; an internal settlement (gift card, store
    // credit) starts processing, its money moved in the claim batch; a refund
    // recorded from the provider starts reconcile_required, its money already gone.
    initial: ["pending", "processing", "reconcile_required"],
    // `refunded` is not final: a provider can turn a completed refund back
    // (Stripe: the buyer's bank returned it), and it is in flight again.
    final: ["failed"],
    moves: {
        /** The request starts the provider call. */
        dispatched: { from: ["pending"], to: "processing" },
        /**
         * Sent, and its outcome is open: the provider has not answered, or its
         * status check needs a person (`needs_staff`). One never sent is never
         * in flight: it fails.
         */
        in_flight: { from: ["processing", "provider_unknown", "provider_processing"], to: "provider_unknown" },
        /**
         * The provider took the refund and is completing it (a Stripe `pending`
         * refund, SSLCommerz's `success`): the money is on its way, so only
         * another refund of it and a dispute's settling wait for it.
         */
        taken: { from: ["processing", "provider_unknown", "provider_processing"], to: "provider_processing" },
        /** The provider completed it but the order's own update failed: the next run settles it. */
        settle_retry: { from: ["processing", "provider_unknown", "provider_processing", "reconcile_required"], to: "reconcile_required" },
        /**
         * The provider refused it, or it was never sent (reconciliation releases
         * a pending attempt whose lease ran out). A refund the provider completed
         * is never failed here: it is reopened first.
         */
        failed: { from: ["pending", "processing", "provider_unknown", "provider_processing"], to: "failed" },
        /** Settled: only an attempt the provider completed, never one that was not sent. */
        refunded: { from: ["processing", "provider_unknown", "provider_processing", "reconcile_required"], to: "refunded" },
        /**
         * The provider says a refund it completed did not reach the buyer (Stripe
         * `refund.failed`, or `requires_action` again): the money is the store's
         * again until its status check settles the refund once more.
         */
        reopened: { from: ["refunded"], to: "provider_processing" },
    },
});
export type RefundAttemptMove = keyof typeof REFUND_ATTEMPT_MACHINE.moves & string;

/** The states a refund is settled in: its money went back, or it never will. */
export const REFUND_ATTEMPT_SETTLED: readonly RefundAttemptStatus[] = ["refunded", "failed"];

/** The states a refund is in flight in: money may still go back. */
export const REFUND_ATTEMPT_IN_FLIGHT: readonly RefundAttemptStatus[] = REFUND_ATTEMPT_STATUSES
    .filter((status) => !REFUND_ATTEMPT_SETTLED.includes(status));

/**
 * The in-flight state that does not hold the order: the provider took the
 * refund and is completing it. Any other in-flight state has an open outcome
 * or its money is being recorded, and locks the order.
 */
export const REFUND_TAKEN_STATUS: RefundAttemptStatus = "provider_processing";

/**
 * The one way an attempt's status changes: the update of `move` over the
 * attempts `where` selects that are still in one of its source states. A
 * move answers whether a person must look: every move clears `needs_staff`
 * unless the caller says otherwise (a check that needs a person sets it).
 */
export function refundAttemptMove(
    db: Database,
    move: RefundAttemptMove,
    where: SQL | undefined,
    extra: { [K in Exclude<keyof typeof refundAttempts.$inferInsert, "status" | "id">]?: (typeof refundAttempts.$inferInsert)[K] | SQL } = {},
) {
    const { from, to } = REFUND_ATTEMPT_MACHINE.moves[move];
    return db.update(refundAttempts).set({
        updatedAt: sql`unixepoch()`,
        needsStaff: false,
        ...extra,
        status: to,
    }).where(and(inArray(refundAttempts.status, [...from]), where));
}
