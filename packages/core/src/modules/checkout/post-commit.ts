// Side effects that run after a storefront order commits.
import type { Database } from "@scalius/database/client";
import { processExistingMetaPurchaseOutboxForOrder } from "../../integrations/meta/purchase-outbox";
import { buildOrderCreatedNotificationDedupeKey, recordAndSendOrderNotification } from "../notifications";
import type { StorefrontOrderCommitPayload } from "../orders";
import { type StorefrontOrderCommitRuntime, wantsOrderCreatedNotification } from "./commit";

export async function runStorefrontOrderPostCommitSideEffects(
    db: Database,
    env: StorefrontOrderCommitRuntime | undefined,
    payload: StorefrontOrderCommitPayload,
): Promise<void> {
    if (payload.checkoutSideEffects?.metaPurchase !== false) {
        await processExistingMetaPurchaseOutboxForOrder({
            db,
            orderId: payload.orderData.id,
            source: "storefront-order",
            storefrontUrl: env?.STOREFRONT_URL,
            encryptionKey: env?.CREDENTIAL_ENCRYPTION_KEY,
        }).catch((error: unknown) => {
            console.error("[orders/commit] Meta Purchase CAPI side effect failed for order", payload.orderData.id, error);
        });
    }

    if (!wantsOrderCreatedNotification(payload)) {
        return;
    }

    try {
        const notificationResult = await recordAndSendOrderNotification({
            db,
            send: env?.sendNotifications,
            notification: {
                dedupeKey: buildOrderCreatedNotificationDedupeKey(payload.orderData.id),
                orderId: payload.orderData.id,
                notificationType: "order_created",
                source: "storefront-order",
            },
        });
        if (!notificationResult.enqueued) {
            console.warn(
                `[orders/commit] order_created notification for ${payload.orderData.id} recorded, left to the scheduled drain: ${notificationResult.skippedReason}`,
            );
        }
    } catch (error) {
        console.error(`[orders/commit] Failed order_created notification side effect for ${payload.orderData.id}:`, error);
    }
}
