import { describe, expect, it } from "vitest";

import {
    buildAdminOrderAmendmentReadiness,
    buildAdminOrderFullEditReadiness,
    type AdminOrderAmendmentSource,
    type AdminOrderFullEditSource,
} from "./orders.admin";

function editableOrder(
    overrides: Partial<AdminOrderFullEditSource> = {},
): AdminOrderFullEditSource {
    return {
        status: "pending",
        paymentStatus: "unpaid",
        paidAmountMinor: 0,
        fulfillmentStatus: "pending",
        shipmentClaimId: null,
        shipmentClaimExpiresAt: null,
        hasTaxSnapshot: false,
        hasPaymentHistory: false,
        hasShipmentHistory: false,
        hasRefundHistory: false,
        hasReturnHistory: false,
        hasInvoiceHistory: false,
        ...overrides,
    };
}

describe("admin full-order edit readiness", () => {
    it.each(["pending", "processing", "confirmed"])(
        "allows an unsettled manual order in %s",
        (status) => {
            expect(buildAdminOrderFullEditReadiness(editableOrder({ status }))).toEqual({
                allowed: true,
                reason: null,
            });
        },
    );

    it("locks shipped and terminal order states", () => {
        const result = buildAdminOrderFullEditReadiness(
            editableOrder({ status: "shipped" }),
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("before shipment");
    });

    // Stored evidence rows (payment, refund, shipment, tax snapshot, return,
    // invoice) are covered end to end in orders.admin-full-edit-readiness.d1.test.ts.
    it.each([
        { paymentStatus: "paid", paidAmountMinor: 10000 },
        { paymentStatus: "unpaid", paidAmountMinor: 100 },
    ])("locks payment state: %o", (override) => {
        const result = buildAdminOrderFullEditReadiness(editableOrder(override));
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("Payment or refund evidence");
    });

    it.each([
        { fulfillmentStatus: "partial" },
        {
            shipmentClaimId: "claim_1",
            shipmentClaimExpiresAt: new Date(Date.now() + 60_000),
        },
    ])("locks fulfillment and shipment evidence: %o", (override) => {
        const result = buildAdminOrderFullEditReadiness(editableOrder(override));
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("Fulfillment or shipment evidence");
    });
});

function amendableOrder(
    overrides: Partial<AdminOrderAmendmentSource> = {},
): AdminOrderAmendmentSource {
    return {
        status: "confirmed",
        paymentMethod: "cod",
        paymentStatus: "unpaid",
        paidAmountMinor: 0,
        fulfillmentStatus: "pending",
        inventoryAction: "reserved",
        shipmentClaimId: null,
        isManualOrder: true,
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

describe("manual COD amendment readiness", () => {
    it("allows only untouched manual COD orders with authoritative snapshots", () => {
        expect(buildAdminOrderAmendmentReadiness(amendableOrder())).toEqual({
            allowed: true,
            reason: null,
        });
    });

    it.each([
        { isManualOrder: false },
        { paymentMethod: "stripe" },
        { paymentStatus: "paid", paidAmountMinor: 10000 },
        { hasPaymentSessionHistory: true },
        { hasPaymentPlan: true },
        { hasCleanCodTracking: false },
        { hasShipmentHistory: true },
        { hasNonPendingItem: true },
        { hasRefundHistory: true },
        { hasReturnHistory: true },
        { hasInvoiceHistory: true },
        { hasTaxSnapshot: false },
        { hasPromotionAllocation: true },
    ])("locks unsafe evidence: %o", (override) => {
        expect(buildAdminOrderAmendmentReadiness(amendableOrder(override)).allowed).toBe(false);
    });
});
