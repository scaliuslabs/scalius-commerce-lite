import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";

import { ValidationError } from "@scalius/core/errors";

import {
    CheckoutFlowRevisionConflictError,
    getCheckoutFlowSettingsDocument,
    saveCheckoutFlowSettingsDocument,
} from "./checkout-flow-admin.service";

function setup() {
    return createSqliteD1Database();
}

const gatewaysOnly = {
    guestCheckoutEnabled: false,
    checkoutMode: "gateways_only" as const,
    partialPaymentEnabled: false,
    partialPaymentAmount: 0,
    availablePaymentMethods: ["stripe"],
};

describe("checkout flow settings revision authority", () => {
    it("reads defaults at revision zero and increments exactly once per current save", async () => {
        const { db } = setup();

        await expect(getCheckoutFlowSettingsDocument(db)).resolves.toMatchObject({ revision: 0, checkoutMode: "all" });
        await saveCheckoutFlowSettingsDocument(db, { ...gatewaysOnly, expectedRevision: 0 });
        const saved = await saveCheckoutFlowSettingsDocument(db, { ...gatewaysOnly, expectedRevision: 1 });

        expect(saved).toMatchObject({ revision: 2, checkoutMode: "gateways_only", guestCheckoutEnabled: false });
        await expect(getCheckoutFlowSettingsDocument(db)).resolves.toEqual(saved);
    });

    it("rejects the stale second tab with the authoritative revision and keeps the first save", async () => {
        const { db } = setup();
        await saveCheckoutFlowSettingsDocument(db, { ...gatewaysOnly, expectedRevision: 0 });

        const error = await saveCheckoutFlowSettingsDocument(db, {
            guestCheckoutEnabled: true,
            checkoutMode: "all",
            partialPaymentEnabled: false,
            partialPaymentAmount: 0,
            expectedRevision: 0,
            availablePaymentMethods: ["cod"],
        }).catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(CheckoutFlowRevisionConflictError);
        expect(error).toMatchObject({
            status: 409,
            code: "CHECKOUT_FLOW_REVISION_CONFLICT",
            details: { expectedRevision: 0, currentRevision: 1 },
        });
        await expect(getCheckoutFlowSettingsDocument(db)).resolves.toMatchObject({ revision: 1, checkoutMode: "gateways_only" });
    });

    it("rejects invalid flow rules before attempting the CAS", async () => {
        const { db } = setup();

        await expect(saveCheckoutFlowSettingsDocument(db, {
            ...gatewaysOnly,
            guestCheckoutEnabled: true,
            expectedRevision: 0,
            availablePaymentMethods: ["cod"],
        })).rejects.toBeInstanceOf(ValidationError);
        await expect(getCheckoutFlowSettingsDocument(db)).resolves.toMatchObject({ revision: 0, checkoutMode: "all" });
    });
});
