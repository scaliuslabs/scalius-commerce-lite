import type { StorefrontOrderCommitPayload } from "../orders";

const INCOMPLETE_ORDER_STATUS = "incomplete";

export function shouldCreateOrderCreatedNotification(
    orderData: Pick<StorefrontOrderCommitPayload["orderData"], "status">,
): boolean {
    return orderData.status.toLowerCase() !== INCOMPLETE_ORDER_STATUS;
}
