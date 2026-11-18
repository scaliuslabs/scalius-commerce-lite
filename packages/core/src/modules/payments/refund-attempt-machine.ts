// The lifecycle of one refund attempt (`refund_attempts.status`). Every write
// of the column is a move of this machine (`refundAttemptMove`): its UPDATE
// names the move's source states, so a writer that lost a race to another
// (the request, reconciliation, staff's check, an import) changes nothing.
// The in-flight states are the ones not final; core's
// ACTIVE_REFUND_ATTEMPT_STATUSES is the same set (refund-attempt-machine.test.ts).
import { and, inArray, sql, type Column, type SQL } from "drizzle-orm";
import { defineMachine } from "@scalius/shared/machine";
import { refundAttempts } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";

export const REFUND_ATTEMPT_STATUSES = ["pending", "processing", "provider_unknown", "reconcile_required", "refunded", "failed"] as const;
export type RefundAttemptStatus = (typeof REFUND_ATTEMPT_STATUSES)[number];

export const REFUND_ATTEMPT_MACHINE = defineMachine({
    name: "refund attempt",
    states: REFUND_ATTEMPT_STATUSES,
    // A provider refund starts pending; an internal settlement (gift card, store
    // credit) starts processing, its money moved in the claim batch; a refund
    // recorded from the provider starts reconcile_required, its money already gone.
    initial: ["pending", "processing", "reconcile_required"],
    final: ["refunded", "failed"],
    moves: {
        /** The request starts the provider call. */
        dispatched: { from: ["pending"], to: "processing" },
        /**
         * Sent, and the provider has not completed it (or has not answered): its
         * status check settles it. One never sent is never in flight: it fails.
         */
        in_flight: { from: ["processing", "provider_unknown"], to: "provider_unknown" },
        /** The provider completed it but the order's own update failed: the next run settles it. */
        settle_retry: { from: ["processing", "provider_unknown", "reconcile_required"], to: "reconcile_required" },
        /**
         * The provider refused it, or it was never sent (reconciliation releases
         * a pending attempt whose lease ran out). A refund the provider completed
         * is never failed here.
         */
        failed: { from: ["pending", "processing", "provider_unknown"], to: "failed" },
        /** Settled: only an attempt the provider completed, never one that was not sent. */
        refunded: { from: ["processing", "provider_unknown", "reconcile_required"], to: "refunded" },
    },
});
export type RefundAttemptMove = keyof typeof REFUND_ATTEMPT_MACHINE.moves & string;

/** The states a refund is in flight in: not final, so money may still go back. */
export const REFUND_ATTEMPT_IN_FLIGHT: readonly RefundAttemptStatus[] = REFUND_ATTEMPT_STATUSES
    .filter((status) => !(REFUND_ATTEMPT_MACHINE.final as readonly string[]).includes(status));

/**
 * Two kinds of `provider_unknown` (a status of its own needs the refund
 * triggers regenerated), from two stored facts:
 *
 * - the provider's refund id: the provider has the refund. Never cleared once
 *   stored: it is the only key some providers' status checks take.
 * - `last_error`: why a person must look, or why the outcome is open. On an
 *   attempt in flight it is written by the request's lost answer, by a probe
 *   that needs a person, and by a reconciliation run that threw; it is
 *   cleared only by an answer that the provider is completing the refund. A
 *   probe that did not get through leaves it as it was.
 *
 * Taken: both say so (an id, no error): the provider answered that it took
 * the refund and is completing it (a Stripe `pending` refund, SSLCommerz's
 * `success`); the money is on its way, so only another refund of it and a
 * dispute's settling wait for it. Anything else in `provider_unknown` has an
 * open outcome or needs a person: the order stays locked and staff are told
 * after a day.
 */
const TAKEN_STATUS: RefundAttemptStatus = "provider_unknown";

interface TakenFacts {
    status: string;
    providerRefundId: string | null | undefined;
    lastError: string | null | undefined;
}

export function refundTakenByProvider(attempt: TakenFacts): boolean {
    return attempt.status === TAKEN_STATUS && attempt.providerRefundId != null && attempt.lastError == null;
}

/** `refundTakenByProvider` as SQL, over the attempt row the columns name (default: `refund_attempts`). */
export function refundTakenByProviderSql(columns: { [K in keyof TakenFacts]: SQL | Column } = {
    status: refundAttempts.status,
    providerRefundId: refundAttempts.providerRefundId,
    lastError: refundAttempts.lastError,
}): SQL {
    return sql`(${columns.status} = ${TAKEN_STATUS} AND ${columns.providerRefundId} IS NOT NULL AND ${columns.lastError} IS NULL)`;
}

/**
 * The one way an attempt's status changes: the update of `move` over the
 * attempts `where` selects that are still in one of its source states.
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
        ...extra,
        status: to,
    }).where(and(inArray(refundAttempts.status, [...from]), where));
}
