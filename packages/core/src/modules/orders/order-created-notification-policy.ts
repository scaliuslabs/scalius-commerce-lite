import type { OrderIngestQueuePayload } from "./orders.types";

const INCOMPLETE_ORDER_STATUS = "incomplete";

export function shouldCreateOrderCreatedNotification(
    orderData: Pick<OrderIngestQueuePayload["orderData"], "status">,
): boolean {
    return orderData.status.toLowerCase() !== INCOMPLETE_ORDER_STATUS;
}
