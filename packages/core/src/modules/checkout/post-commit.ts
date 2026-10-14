// Side effects that run after a storefront order commits.
import type { Database } from "@scalius/database/client";
import { processExistingMetaPurchaseOutboxForOrder } from "../../integrations/meta/purchase-outbox";
import { orderCreatedNotificationOutboxId } from "../notifications";
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

    // The commit batch wrote the row under a fixed id: send it without a read.
    // Without a sender the scheduled drain sends it.
    try {
        await env?.sendNotifications?.([orderCreatedNotificationOutboxId(payload.orderData.id)]);
    } catch (error) {
        console.error(`[orders/commit] order_created notification for ${payload.orderData.id} left to the scheduled drain:`, error);
    }
}
