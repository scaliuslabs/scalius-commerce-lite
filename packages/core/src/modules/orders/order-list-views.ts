import { OrderStatus, type OrderStatus as OrderStatusValue } from "@scalius/database/schema";

export const ORDER_STATUS_GROUPS = {
    open: [
        OrderStatus.INCOMPLETE,
        OrderStatus.PENDING,
        OrderStatus.PROCESSING,
        OrderStatus.CONFIRMED,
    ],
    in_transit: [OrderStatus.SHIPPED],
    delivered: [OrderStatus.DELIVERED],
    closed: [
        OrderStatus.COMPLETED,
        OrderStatus.CANCELLED,
        OrderStatus.REFUNDED,
        OrderStatus.RETURNED,
        OrderStatus.PARTIALLY_REFUNDED,
    ],
} as const satisfies Record<string, readonly OrderStatusValue[]>;

export type OrderStatusGroup = keyof typeof ORDER_STATUS_GROUPS;

export function getOrderStatusGroupStatuses(group: OrderStatusGroup): readonly OrderStatusValue[] {
    return ORDER_STATUS_GROUPS[group];
}
