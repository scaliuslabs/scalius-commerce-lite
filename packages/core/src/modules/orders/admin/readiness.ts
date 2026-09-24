// Whether staff may still edit an order, and why not.
import type { Database } from "@scalius/database/client";
import {
    orders,
    OrderStatus,
    PaymentMethod,
    PaymentStatus,
    FulfillmentStatus,
} from "@scalius/database/schema";
import { eq, isNull, and } from "drizzle-orm";
import type { OrderEditLockReason, OrderEditReadiness } from "../types";
import { OPEN_ORDER_STATUSES, orderEditEvidenceSelection } from "./shared";

const SENT_ORDER_STATUSES = new Set<string>([
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
    OrderStatus.COMPLETED,
]);

/** Facts that decide what a merchant may still change on an order. */
export interface OrderEditSource {
    status: string;
    paymentMethod: string | null;
    paymentStatus: string | null;
    paidAmountMinor: number;
    fulfillmentStatus: string | null;
    inventoryAction: string | null;
    shipmentClaimId: string | null;
    archivedAt: unknown;
    hasTaxSnapshot: number | boolean;
    hasPaymentHistory: number | boolean;
    hasPaymentSessionHistory: number | boolean;
    hasShipmentHistory: number | boolean;
    hasRefundHistory: number | boolean;
    hasReturnHistory: number | boolean;
    hasInvoiceHistory: number | boolean;
    hasPaymentPlan: number | boolean;
    hasPromotionAllocation: number | boolean;
    hasNonPendingItem: number | boolean;
    hasCleanCodTracking: number | boolean;
}

function editState(reason: OrderEditLockReason | null) {
    return { allowed: reason === null, reason };
}

/**
 * Customer and delivery details stay editable until the order ships; items,
 * quantities and the delivery charge change through a quote-backed amendment
 * only on an unpaid, unshipped cash-on-delivery order with no discount code,
 * so its tax and line snapshots stay truthful (ORD-03).
 */
export function buildOrderEditReadiness(order: OrderEditSource): OrderEditReadiness {
    const detailsLock: OrderEditLockReason | null = order.archivedAt != null
        ? "archived"
        : SENT_ORDER_STATUSES.has(order.status)
            ? "shipped"
            : !OPEN_ORDER_STATUSES.has(order.status)
                ? "closed"
                : order.fulfillmentStatus !== FulfillmentStatus.PENDING
                    || Boolean(order.hasShipmentHistory)
                    || Boolean(order.hasNonPendingItem)
                    ? "shipped"
                    : order.shipmentClaimId
                        ? "busy"
                        : null;
    const itemsLock: OrderEditLockReason | null = detailsLock
        ?? (order.paymentMethod !== PaymentMethod.COD
            ? "online_payment"
            : order.paymentStatus !== PaymentStatus.UNPAID
                || order.paidAmountMinor !== 0
                || Boolean(order.hasPaymentHistory)
                || Boolean(order.hasPaymentSessionHistory)
                || Boolean(order.hasPaymentPlan)
                || !order.hasCleanCodTracking
                ? "paid"
                : Boolean(order.hasRefundHistory)
                    || Boolean(order.hasReturnHistory)
                    || Boolean(order.hasInvoiceHistory)
                    || !order.hasTaxSnapshot
                    ? "history"
                    : order.hasPromotionAllocation
                        ? "discount"
                        : order.inventoryAction !== "reserved" && order.inventoryAction !== "none"
                            ? "inventory"
                            : null);
    return { items: editState(itemsLock), details: editState(detailsLock) };
}

export async function getOrderEditReadiness(
    db: Database,
    orderId: string,
): Promise<OrderEditReadiness | null> {
    const order = await db.select({ status: orders.status, ...orderEditEvidenceSelection() })
        .from(orders)
        .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
        .get();
    return order ? buildOrderEditReadiness(order) : null;
}

const EDIT_LOCK_MESSAGES: Record<OrderEditLockReason, string> = {
    shipped: "This order has been sent, so it can't be changed.",
    closed: "This order is closed, so it can't be changed.",
    archived: "Unarchive this order to change it.",
    busy: "A courier booking is in progress. Try again in a minute.",
    online_payment: "Items on an online-paid order can't be changed. Refund or create a new order instead.",
    paid: "Items can't be changed after payment. Refund or create a new order instead.",
    history: "Items can't be changed after a refund, return or invoice. Create a new order instead.",
    discount: "This order used a discount, so its items can't be changed. You can still edit the customer and address.",
    inventory: "Stock for this order needs attention before its items can change.",
    unavailable: "A product on this order is no longer sold, so its items can't be changed. You can still edit the customer and address.",
};

export function orderEditLockMessage(reason: OrderEditLockReason | null): string {
    return reason ? EDIT_LOCK_MESSAGES[reason] : "This order can't be changed.";
}
