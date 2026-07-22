import { describe, expect, it } from "vitest";
import { OrderStatus } from "@scalius/database/schema";
import {
    ORDER_STATUS_GROUPS,
    getOrderStatusGroupStatuses,
} from "./order-list-views";

describe("order list lifecycle views", () => {
    it("assigns every order state to exactly one workflow view", () => {
        const groupedStatuses = Object.values(ORDER_STATUS_GROUPS).flat();

        expect(new Set(groupedStatuses).size).toBe(groupedStatuses.length);
        expect([...groupedStatuses].sort()).toEqual(Object.values(OrderStatus).sort());
    });

    it("keeps active fulfillment work in the open view", () => {
        expect(getOrderStatusGroupStatuses("open")).toEqual([
            OrderStatus.INCOMPLETE,
            OrderStatus.PENDING,
            OrderStatus.PROCESSING,
            OrderStatus.CONFIRMED,
        ]);
    });
});
