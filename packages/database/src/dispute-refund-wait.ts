// The refund attempt in-flight set as the database stores it: the
// source-payment single-flight index (one refund of a payment's money at a
// time) and the trigger that wakes parked disputes when a refund settles.
//
// A provider's dispute event that arrived while a refund on its order was in
// flight waits (`webhook_events.status = 'retrying'`, `result.reason =
// 'refund_in_flight'`, apps/api utils/webhook-idempotency.ts). Whatever ends
// the refund (its success, its failure, a cancel or staff's resolution) makes
// those events due at once, so the dispute is recorded on the payment
// drain's next tick and never waits on a backstop. One trigger on the
// attempt row catches every settling write. Pure SQL text, no imports: the
// migrations (0220, 0222) and their tests share it.

/**
 * A refund attempt still in flight: core's REFUND_ATTEMPT_IN_FLIGHT
 * (order-kernel/refund-attempt-machine.ts; a core test keeps them equal).
 */
export const IN_FLIGHT_REFUND_ATTEMPT_STATUSES = ["pending", "processing", "provider_unknown", "provider_processing", "reconcile_required"] as const;

/** The set as 0220 stored it (that deployed migration renders with it). */
export const IN_FLIGHT_REFUND_ATTEMPT_STATUSES_0220 = ["pending", "processing", "provider_unknown", "reconcile_required"] as const;

/** The parked reason: core's REFUND_IN_FLIGHT_PARKED_PAYMENT_EVENT (payments/disputes.ts; a core test keeps them equal). */
export const REFUND_IN_FLIGHT_REASON = "refund_in_flight";

export interface RefundSettledTrigger { name: string; table: string; sqlite: string }

const inFlightList = (statuses: readonly string[] = IN_FLIGHT_REFUND_ATTEMPT_STATUSES) => statuses.map((status) => `'${status}'`).join(", ");

/** The trigger that makes the order's parked dispute events due when one of its refund attempts settles. */
export function generateRefundSettledRequeueTrigger(statuses: readonly string[] = IN_FLIGHT_REFUND_ATTEMPT_STATUSES): RefundSettledTrigger {
  const inFlight = inFlightList(statuses);
  return {
    name: "refund_attempts_settled_requeue_disputes",
    table: "refund_attempts",
    // The guard is the trigger's WHEN (remote D1 refuses a CASE in the body);
    // the body reads the order's events through webhook_events_order_id_idx.
    sqlite: `CREATE TRIGGER refund_attempts_settled_requeue_disputes
AFTER UPDATE OF status ON refund_attempts
WHEN OLD.status IN (${inFlight}) AND NEW.status NOT IN (${inFlight})
BEGIN
  UPDATE webhook_events SET next_attempt_at = unixepoch()
  WHERE order_id = NEW.order_id AND status = 'retrying' AND json_extract(result, '$.reason') = '${REFUND_IN_FLIGHT_REASON}';
END`,
  };
}

/** At most one refund of a source payment's money in flight: its partial unique index (no trailing semicolon). */
export const REFUND_SINGLE_FLIGHT_INDEX = "refund_attempts_live_source_payment_singleflight";

export function generateRefundSingleFlightIndex(): string {
  return `CREATE UNIQUE INDEX \`${REFUND_SINGLE_FLIGHT_INDEX}\`
ON \`refund_attempts\` (\`source_payment_id\`)
WHERE \`status\` IN (${inFlightList()})`;
}

/**
 * Migration 0222's statements around its Drizzle DDL: the in-flight set
 * gains `provider_processing`, the refunds the provider took and is
 * completing (until then `provider_unknown` with a provider refund id and no
 * `last_error`) are moved to it, and the index and trigger that name the set
 * are recreated with it. The mapping writes only the rows that hold that
 * state; it leaves the set of in-flight rows unchanged, so the recreated
 * unique index finds no new conflict.
 */
export function refundProviderProcessingStatements(): string[] {
  return [
    "DROP TRIGGER IF EXISTS refund_attempts_settled_requeue_disputes",
    `DROP INDEX IF EXISTS \`${REFUND_SINGLE_FLIGHT_INDEX}\``,
    "UPDATE `refund_attempts` SET `status` = 'provider_processing' WHERE `status` = 'provider_unknown' AND `provider_refund_id` IS NOT NULL AND `last_error` IS NULL",
    generateRefundSingleFlightIndex(),
    generateRefundSettledRequeueTrigger().sqlite,
  ];
}
