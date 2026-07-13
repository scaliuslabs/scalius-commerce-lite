import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { siteSettings } from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";

import {
    CheckoutFlowRevisionConflictError,
    getCheckoutFlowSettingsDocument,
    saveCheckoutFlowSettingsDocument,
} from "./checkout-flow-admin.service";

const serviceSource = readFileSync(
    new URL("./checkout-flow-admin.service.ts", import.meta.url),
    "utf8",
);

function checkoutDocument(revision: number) {
    return {
        guestCheckoutEnabled: true,
        checkoutMode: "all" as const,
        partialPaymentEnabled: false,
        partialPaymentAmount: 0,
        revision,
    };
}

function createDb(options: {
    currentRevision?: number;
    updateSucceeds?: boolean;
    missing?: boolean;
} = {}) {
    const currentRevision = options.currentRevision ?? 1;
    const update = vi.fn((table: unknown) => {
        expect(table).toBe(siteSettings);
        return {
            set: vi.fn(() => ({
                where: vi.fn(() => ({
                    returning: vi.fn(async () => options.updateSucceeds === false
                        ? []
                        : [checkoutDocument(currentRevision + 1)]),
                })),
            })),
        };
    });
    const select = vi.fn((shape: Record<string, unknown>) => ({
        from: vi.fn((table: unknown) => {
            expect(table).toBe(siteSettings);
            const row = options.missing
                ? undefined
                : "guestCheckoutEnabled" in shape
                    ? checkoutDocument(currentRevision)
                    : { revision: currentRevision };
            return {
                limit: vi.fn(() => ({ get: vi.fn(async () => row) })),
                where: vi.fn(() => ({ get: vi.fn(async () => row) })),
            };
        }),
    }));

    return { db: { select, update }, select, update };
}

describe("checkout flow settings revision authority", () => {
    it("reads the initialized legacy row at migration revision one", async () => {
        const { db } = createDb({ currentRevision: 1 });

        await expect(getCheckoutFlowSettingsDocument(db as never)).resolves.toEqual(
            checkoutDocument(1),
        );
    });

    it("increments exactly once when the expected revision is current", async () => {
        const { db, update } = createDb({ currentRevision: 4 });

        const saved = await saveCheckoutFlowSettingsDocument(db as never, {
            guestCheckoutEnabled: false,
            checkoutMode: "gateways_only",
            partialPaymentEnabled: false,
            partialPaymentAmount: 0,
            expectedRevision: 4,
            availablePaymentMethods: ["stripe"],
        });

        expect(saved.revision).toBe(5);
        expect(update).toHaveBeenCalledOnce();
    });

    it("returns the authoritative current revision for the stale second tab", async () => {
        const { db } = createDb({ currentRevision: 5, updateSucceeds: false });

        const error = await saveCheckoutFlowSettingsDocument(db as never, {
            guestCheckoutEnabled: true,
            checkoutMode: "all",
            partialPaymentEnabled: false,
            partialPaymentAmount: 0,
            expectedRevision: 4,
            availablePaymentMethods: ["cod"],
        }).catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(CheckoutFlowRevisionConflictError);
        expect(error).toMatchObject({
            status: 409,
            code: "CHECKOUT_FLOW_REVISION_CONFLICT",
            details: { expectedRevision: 4, currentRevision: 5 },
        });
    });

    it("rejects invalid flow rules before attempting the CAS", async () => {
        const { db, update } = createDb();

        await expect(saveCheckoutFlowSettingsDocument(db as never, {
            guestCheckoutEnabled: true,
            checkoutMode: "gateways_only",
            partialPaymentEnabled: false,
            partialPaymentAmount: 0,
            expectedRevision: 1,
            availablePaymentMethods: ["cod"],
        })).rejects.toBeInstanceOf(ValidationError);
        expect(update).not.toHaveBeenCalled();
    });

    it("keeps the expected revision in the atomic update predicate", () => {
        expect(serviceSource).toContain(
            "eq(siteSettings.singletonKey, \"default\")",
        );
        expect(serviceSource).toContain(
            "eq(siteSettings.checkoutFlowRevision, input.expectedRevision)",
        );
        expect(serviceSource).toContain(
            "checkoutFlowRevision: sql`${siteSettings.checkoutFlowRevision} + 1`",
        );
    });
});
