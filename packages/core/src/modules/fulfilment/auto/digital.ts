// The digital fulfiller (Wave B §3.3): entitlements for file assets, FIFO
// licence keys from the variant's pool, and the `order_digital_delivered`
// outbox row, all in the auto-fulfil batch after the ledger insert.
//
// Composed here (fulfilment already depends on notifications) so the digital
// domain never imports notifications. When a pool is short, nothing is
// delivered: a staff alert (deduped per variant per day) is recorded and the
// run fails, so the line stays owed and the 15-minute sweep retries after keys
// are imported. The outbox rows carry ids only; keys and file names are
// resolved when the message is sent.
import { DIGITAL_KEYS_EXHAUSTED, planDigitalDelivery } from "../../digital/fulfiller";
import { buildNotificationOutboxInsert } from "../../notifications";
import type { AutoFulfiller } from "../registry";

/** The delivery message for one fulfilment; a retried batch keeps one row. */
export function digitalDeliveredDedupeKey(orderId: string, fulfillmentId: string): string {
    return `order:${orderId}:digital_delivered:${fulfillmentId}`;
}

/** The run failed because a pool is short; the sweep retries it. */
export class DigitalKeysExhaustedError extends Error {
    constructor(readonly variantIds: readonly string[]) {
        super(`${DIGITAL_KEYS_EXHAUSTED}: not enough licence keys for ${variantIds.length} variant(s)`);
        this.name = "DigitalKeysExhaustedError";
    }
}

/** Nothing ready to deliver for a line (its files were archived after checkout). */
export class DigitalNothingToDeliverError extends Error {
    constructor(readonly orderItemIds: readonly string[]) {
        super(`Nothing ready to deliver for ${orderItemIds.length} digital line(s)`);
        this.name = "DigitalNothingToDeliverError";
    }
}

export const digitalFulfiller: AutoFulfiller = {
    async prepare(db, context) {
        const now = Math.floor(Date.now() / 1000);
        const plan = await planDigitalDelivery(db, context, now);
        if (plan.shortPools.length > 0) {
            const day = new Date(now * 1000).toISOString().slice(0, 10);
            for (const pool of plan.shortPools) {
                const alert = buildNotificationOutboxInsert(db, {
                    subjectType: "order",
                    subjectId: context.orderId,
                    audience: "staff",
                    notificationType: "digital_keys_exhausted",
                    dedupeKey: `digital_keys_exhausted:${pool.variantId}:${day}`,
                    source: "auto_fulfil",
                    data: { variantId: pool.variantId, assetId: pool.assetId, needed: pool.needed, available: pool.available },
                });
                await alert.statement.run();
            }
            throw new DigitalKeysExhaustedError(plan.shortPools.map((pool) => pool.variantId));
        }
        if (plan.emptyLines.length > 0) throw new DigitalNothingToDeliverError(plan.emptyLines);
        const delivered = buildNotificationOutboxInsert(db, {
            subjectType: "order",
            subjectId: context.orderId,
            audience: "customer",
            notificationType: "order_digital_delivered",
            dedupeKey: digitalDeliveredDedupeKey(context.orderId, context.fulfillmentId),
            source: "auto_fulfil",
            data: { fulfillmentId: context.fulfillmentId },
        });
        return [...plan.statements, delivered.statement];
    },
};
