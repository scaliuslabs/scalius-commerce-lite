import { describe, expect, it } from "vitest";

import {
    buildAdminOrderFullEditReadiness,
    type AdminOrderFullEditSource,
} from "./orders.admin";

function editableOrder(
    overrides: Partial<AdminOrderFullEditSource> = {},
): AdminOrderFullEditSource {
    return {
        status: "pending",
        paymentStatus: "unpaid",
        paidAmount: 0,
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

    it.each([
        { paymentStatus: "paid", paidAmount: 100 },
        { hasPaymentHistory: true },
        { hasRefundHistory: true },
    ])("locks payment and refund evidence: %o", (override) => {
        const result = buildAdminOrderFullEditReadiness(editableOrder(override));
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("Payment or refund evidence");
    });

    it.each([
        { fulfillmentStatus: "partial" },
        { hasShipmentHistory: true },
        {
            shipmentClaimId: "claim_1",
            shipmentClaimExpiresAt: new Date(Date.now() + 60_000),
        },
    ])("locks fulfillment and shipment evidence: %o", (override) => {
        const result = buildAdminOrderFullEditReadiness(editableOrder(override));
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("Fulfillment or shipment evidence");
    });

    it("locks immutable checkout tax snapshots", () => {
        const result = buildAdminOrderFullEditReadiness(
            editableOrder({ hasTaxSnapshot: true }),
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("immutable tax and line snapshots");
    });

    it("locks an aggregate checkout until normalized read models are complete", () => {
        const result = buildAdminOrderFullEditReadiness(editableOrder({
            checkoutAggregateVersion: 1,
            checkoutProjectionStatus: "pending",
        }));
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("materializing");
    });

    it.each([{ hasReturnHistory: true }, { hasInvoiceHistory: true }])(
        "locks return and invoice evidence: %o",
        (override) => {
            const result = buildAdminOrderFullEditReadiness(editableOrder(override));
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("Return or invoice evidence");
        },
    );
});
