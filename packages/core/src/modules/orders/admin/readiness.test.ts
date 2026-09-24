import { describe, expect, it } from "vitest";

import { buildOrderEditReadiness, type OrderEditSource } from "./readiness";

function order(overrides: Partial<OrderEditSource> = {}): OrderEditSource {
    return {
        status: "confirmed",
        paymentMethod: "cod",
        paymentStatus: "unpaid",
        paidAmountMinor: 0,
        fulfillmentStatus: "pending",
        inventoryAction: "reserved",
        shipmentClaimId: null,
        archivedAt: null,
        hasTaxSnapshot: true,
        hasPaymentHistory: false,
        hasPaymentSessionHistory: false,
        hasShipmentHistory: false,
        hasRefundHistory: false,
        hasReturnHistory: false,
        hasInvoiceHistory: false,
        hasPaymentPlan: false,
        hasPromotionAllocation: false,
        hasNonPendingItem: false,
        hasCleanCodTracking: true,
        ...overrides,
    };
}

describe("order edit readiness", () => {
    it.each(["pending", "processing", "confirmed"])(
        "lets a %s COD order (dashboard or storefront) change items and details",
        (status) => {
            expect(buildOrderEditReadiness(order({ status }))).toEqual({
                items: { allowed: true, reason: null },
                details: { allowed: true, reason: null },
            });
        },
    );

    it.each([
        [{ status: "shipped" }, "shipped"],
        [{ status: "delivered" }, "shipped"],
        [{ fulfillmentStatus: "partial" }, "shipped"],
        [{ hasShipmentHistory: true }, "shipped"],
        [{ status: "cancelled" }, "closed"],
        [{ status: "incomplete" }, "closed"],
        [{ archivedAt: new Date() }, "archived"],
        [{ shipmentClaimId: "claim_1" }, "busy"],
    ] as const)("locks everything for %o (%s)", (override, reason) => {
        expect(buildOrderEditReadiness(order(override))).toEqual({
            items: { allowed: false, reason },
            details: { allowed: false, reason },
        });
    });

    it.each([
        [{ paymentMethod: "stripe" }, "online_payment"],
        [{ paymentStatus: "paid", paidAmountMinor: 10000 }, "paid"],
        [{ hasPaymentSessionHistory: true }, "paid"],
        [{ hasPaymentPlan: true }, "paid"],
        [{ hasCleanCodTracking: false }, "paid"],
        [{ hasRefundHistory: true }, "history"],
        [{ hasReturnHistory: true }, "history"],
        [{ hasInvoiceHistory: true }, "history"],
        [{ hasTaxSnapshot: false }, "history"],
        [{ hasPromotionAllocation: true }, "discount"],
        [{ inventoryAction: "deducted" }, "inventory"],
    ] as const)("keeps details editable but locks items for %o (%s)", (override, reason) => {
        expect(buildOrderEditReadiness(order(override))).toEqual({
            items: { allowed: false, reason },
            details: { allowed: true, reason: null },
        });
    });
});
