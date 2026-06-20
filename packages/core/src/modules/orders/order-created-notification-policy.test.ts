import { describe, expect, it } from "vitest";

import { shouldCreateOrderCreatedNotification } from "./order-created-notification-policy";

describe("shouldCreateOrderCreatedNotification", () => {
    it("defers order-created notifications for incomplete online orders", () => {
        expect(shouldCreateOrderCreatedNotification({ status: "incomplete" })).toBe(false);
        expect(shouldCreateOrderCreatedNotification({ status: "INCOMPLETE" })).toBe(false);
    });

    it("allows order-created notifications after an order is accepted", () => {
        expect(shouldCreateOrderCreatedNotification({ status: "pending" })).toBe(true);
        expect(shouldCreateOrderCreatedNotification({ status: "confirmed" })).toBe(true);
    });
});
