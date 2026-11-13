// A provider's dispute event that arrived while a refund on its order was in
// flight waits (`webhook_events.status = 'retrying'`, `result.reason =
// 'refund_in_flight'`, apps/api utils/webhook-idempotency.ts). Whatever ends
// the refund (its success, its failure, a cancel or staff's resolution) makes
// those events due at once, so the dispute is recorded on the payment
// drain's next tick and never waits on a backstop. One trigger on the
// attempt row catches every settling write. Pure SQL text, no imports: the
// migration (0220) and its tests share it.

/**
 * A refund attempt still in flight: core's ACTIVE_REFUND_ATTEMPT_STATUSES
 * (order-kernel/refund-attempt-guard.ts; a core test keeps them equal).
 */
export const IN_FLIGHT_REFUND_ATTEMPT_STATUSES = ["pending", "processing", "provider_unknown", "reconcile_required"] as const;

/** The parked reason: core's REFUND_IN_FLIGHT_PARKED_PAYMENT_EVENT (payments/disputes.ts; a core test keeps them equal). */
export const REFUND_IN_FLIGHT_REASON = "refund_in_flight";

export interface RefundSettledTrigger { name: string; table: string; sqlite: string }

/** The trigger that makes the order's parked dispute events due when one of its refund attempts settles. */
export function generateRefundSettledRequeueTrigger(): RefundSettledTrigger {
  const inFlight = IN_FLIGHT_REFUND_ATTEMPT_STATUSES.map((status) => `'${status}'`).join(", ");
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
