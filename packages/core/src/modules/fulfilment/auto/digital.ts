// The digital fulfiller (Wave B §3.3): entitlements for file assets, FIFO
// licence keys from the variant's pool, and the `order_digital_delivered`
// outbox row, all in the auto-fulfil batch after the ledger insert.
//
// Composed here (fulfilment already depends on notifications) so the digital
// domain never imports notifications. Lines are planned one by one: the ready
// ones are delivered, and a line with nothing ready or whose pool is short
// stays owed with a staff alert (a short pool once per variant per day, an
// empty line once per line per day); the sweep delivers it once keys are
// imported or a file is ready. The outbox rows carry ids only; keys and file
// names are resolved when the message is sent.
import { DIGITAL_KEYS_EXHAUSTED, planDigitalDelivery } from "../../digital";
import { buildNotificationOutboxInsert } from "../../notifications";
import type { AutoFulfiller } from "../registry";
import { safeBatch } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";

/** The delivery message for one fulfilment; a retried batch keeps one row. */
export function digitalDeliveredDedupeKey(orderId: string, fulfillmentId: string): string {
    return `order:${orderId}:digital_delivered:${fulfillmentId}`;
}

export const digitalFulfiller: AutoFulfiller = {
    async prepare(db, context) {
        const now = Math.floor(Date.now() / 1000);
        const plan = await planDigitalDelivery(db, context, now);
        const day = new Date(now * 1000).toISOString().slice(0, 10);
        const alerts = [
            ...plan.shortPools.map((pool) => ({
                dedupeKey: `digital_keys_exhausted:${pool.variantId}:${day}`,
                data: { reason: "keys_exhausted", variantId: pool.variantId, assetId: pool.assetId, needed: pool.needed, available: pool.available },
            })),
            ...plan.emptyLines.map((orderItemId) => ({
                dedupeKey: `digital_nothing_ready:${orderItemId}:${day}`,
                data: { reason: "nothing_ready", orderItemId },
            })),
        ];
        // Raised now in one round trip, whatever the handover batch does: the owed lines wait for staff.
        if (alerts.length > 0) {
            await safeBatch(db, alerts.map((alert) => buildNotificationOutboxInsert(db, {
                subjectType: "order",
                subjectId: context.orderId,
                audience: "staff",
                notificationType: "digital_keys_exhausted",
                dedupeKey: alert.dedupeKey,
                source: "auto_fulfil",
                data: alert.data,
            }).statement as unknown as BatchItem<"sqlite">));
        }
        const owedReason = plan.shortLines.length > 0
            ? `${DIGITAL_KEYS_EXHAUSTED}: not enough licence keys for ${plan.shortLines.length} digital line(s)`
            : plan.emptyLines.length > 0
                ? `Nothing ready to deliver for ${plan.emptyLines.length} digital line(s)`
                : undefined;
        if (plan.deliveredLineIds.length === 0) return { statements: [], deliveredLineIds: [], owedReason };
        const delivered = buildNotificationOutboxInsert(db, {
            subjectType: "order",
            subjectId: context.orderId,
            audience: "customer",
            notificationType: "order_digital_delivered",
            dedupeKey: digitalDeliveredDedupeKey(context.orderId, context.fulfillmentId),
            source: "auto_fulfil",
            data: { fulfillmentId: context.fulfillmentId },
        });
        return { statements: [...plan.statements, delivered.statement], deliveredLineIds: plan.deliveredLineIds, owedReason };
    },
};
