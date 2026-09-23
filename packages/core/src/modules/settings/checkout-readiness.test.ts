import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getEmailProviderReadiness: vi.fn(),
    getSmsProviderReadiness: vi.fn(),
    getWhatsAppCloudApiSettings: vi.fn(),
}));

vi.mock("../../integrations/email", () => ({
    getEmailProviderReadiness: mocks.getEmailProviderReadiness,
}));
vi.mock("../../integrations/sms", () => ({
    getSmsProviderReadiness: mocks.getSmsProviderReadiness,
}));
vi.mock("../../integrations/whatsapp", () => ({
    getWhatsAppCloudApiSettings: mocks.getWhatsAppCloudApiSettings,
}));

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { checkoutDocument } from "./documents";
import {
    CHECKOUT_READINESS_CODES,
    CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE,
    getCheckoutReadiness,
    getCustomerSignInReadiness,
} from "./checkout-readiness";

async function createAuthDb(options: {
    guestCheckoutEnabled: boolean;
    authVerificationMethod?: string;
    policy?: Record<string, unknown>;
}) {
    const harness = createSqliteD1Database();
    await checkoutDocument.write(harness.db, { guestCheckoutEnabled: options.guestCheckoutEnabled });
    harness.sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('auth', 'document', ?, 'json', 'customer_auth')")
        .run(JSON.stringify({
            authVerificationMethod: options.authVerificationMethod ?? "email",
            policy: options.policy ?? null,
        }));
    return harness;
}

describe("customer checkout sign-in readiness", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getEmailProviderReadiness.mockResolvedValue({ status: "incomplete", issues: [] });
        mocks.getSmsProviderReadiness.mockResolvedValue({ status: "incomplete", issues: [] });
        mocks.getWhatsAppCloudApiSettings.mockResolvedValue({});
    });

    it("blocks checkout when accounts are required and no sign-in channel is usable", async () => {
        const { db, sqlite } = await createAuthDb({ guestCheckoutEnabled: false });
        sqlite.exec(`INSERT INTO shipping_methods (id, name, fee, is_active) VALUES ('sm_1', 'Standard', 60, 1);
            INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
            VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1),
                   ('zone_1', 'Dhanmondi', 'zone', 'city_1', '{}', '{}', 1);`);

        await expect(getCheckoutReadiness(db, {})).resolves.toEqual({
            status: "incomplete",
            issues: [CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE],
            hasActiveShippingMethod: true,
            hasActiveDeliveryHierarchy: true,
            customerSignInRequired: true,
            hasUsableCustomerSignIn: false,
        });
        expect(CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE.code)
            .toBe(CHECKOUT_READINESS_CODES.customerSignIn);
        expect(mocks.getEmailProviderReadiness).not.toHaveBeenCalled();
    });

    it("fails closed when accounts are required without the credential encryption key", async () => {
        const result = await getCustomerSignInReadiness(
            (await createAuthDb({ guestCheckoutEnabled: false })).db,
            {},
        );

        expect(result).toEqual({
            status: "incomplete",
            issues: [CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE],
            customerSignInRequired: true,
            hasUsableCustomerSignIn: false,
        });
        expect(mocks.getEmailProviderReadiness).not.toHaveBeenCalled();
    });

    it("accepts a configured provider allowed by the saved customer auth policy", async () => {
        mocks.getSmsProviderReadiness.mockResolvedValue({ status: "ready", issues: [], activeProvider: "mimsms" });
        const { db } = await createAuthDb({
            guestCheckoutEnabled: false,
            policy: {
                otpChannels: ["sms"],
                requiredContactFields: ["phone"],
                optionalContactFields: ["email"],
                defaultOtpChannel: "sms",
            },
        });

        await expect(getCustomerSignInReadiness(db, {
            encryptionKey: "credential-key",
        })).resolves.toEqual({
            status: "ready",
            issues: [],
            customerSignInRequired: true,
            hasUsableCustomerSignIn: true,
        });
        expect(mocks.getSmsProviderReadiness).toHaveBeenCalledWith(db, "credential-key");
    });

    it("does not read optional sign-in providers on the public guest-checkout path", async () => {
        const result = await getCustomerSignInReadiness(
            (await createAuthDb({ guestCheckoutEnabled: true })).db,
            {},
        );

        expect(result).toEqual({
            status: "ready",
            issues: [],
            customerSignInRequired: false,
            hasUsableCustomerSignIn: true,
        });
        expect(mocks.getEmailProviderReadiness).not.toHaveBeenCalled();
    });

    it("lets the admin preview optional sign-in provider readiness before requiring accounts", async () => {
        const result = await getCustomerSignInReadiness(
            (await createAuthDb({ guestCheckoutEnabled: true })).db,
            { inspectOptionalCustomerSignIn: true },
        );

        // Optional sign-in is only a preview signal, never a checkout blocker.
        expect(result).toEqual({
            status: "ready",
            issues: [],
            customerSignInRequired: false,
            hasUsableCustomerSignIn: false,
        });
    });
});
