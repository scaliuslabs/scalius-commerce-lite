import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getPaymentGatewaySettingsSnapshot: vi.fn(),
}));

vi.mock("../payments/gateway-settings", async (importOriginal) => ({
    ...await importOriginal<typeof import("../payments/gateway-settings")>(),
    getPaymentGatewaySettingsSnapshot: mocks.getPaymentGatewaySettingsSnapshot,
}));

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getCheckoutConfig } from "./checkout-config.service";
import { checkoutDocument, currencyDocument } from "./documents";

async function createDb(
    siteOverrides: Record<string, unknown> = {},
    customerAuthPolicy?: Record<string, unknown>,
    readiness: {
        activeShippingRows?: Array<{ id: string }>;
        activeHierarchyRows?: Array<{ id: string }>;
        currency?: { currencyCode: string; currencySymbol: string };
    } = {},
) {
    const { db, sqlite } = createSqliteD1Database();
    const { authVerificationMethod = "email", ...checkout } = siteOverrides;
    await checkoutDocument.write(db, checkout);
    // As migrated: the raw saved method, plus a policy only when one was saved.
    sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('auth', 'document', ?, 'json', 'customer_auth')")
        .run(JSON.stringify({ authVerificationMethod, policy: customerAuthPolicy ?? null }));
    await currencyDocument.write(db, (readiness.currency ?? { currencyCode: "bdt", currencySymbol: "৳" }) as never);
    if ((readiness.activeShippingRows ?? [{ id: "sm_1" }]).length > 0) {
        sqlite.exec("INSERT INTO shipping_methods (id, name, fee, is_active) VALUES ('sm_1', 'Standard', 60, 1)");
    }
    if ((readiness.activeHierarchyRows ?? [{ id: "zone_1" }]).length > 0) {
        sqlite.exec(`INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
            VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1),
                   ('zone_1', 'Dhanmondi', 'zone', 'city_1', '{}', '{}', 1)`);
    }
    return db;
}

const readyStripe = {
    enabled: true,
    secretKey: "sk_test_realishValue",
    publishableKey: "pk_test_realishValue",
    webhookSecret: "whsec_realishValue",
};

function mockGatewaySnapshot(
    activePaymentMethods: { enabledMethods: string[]; defaultMethod: string },
    stripe: Partial<typeof readyStripe> | null = readyStripe,
) {
    mocks.getPaymentGatewaySettingsSnapshot.mockResolvedValue({
        preferences: {
            enabledMethods: activePaymentMethods.enabledMethods,
            defaultMethod: activePaymentMethods.defaultMethod,
            hasExplicitEnabledMethods: true,
        },
        activePaymentMethods,
        settings: {
            stripe,
            sslcommerz: null,
            cod: { enabled: true },
        },
    });
}

describe("getCheckoutConfig", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGatewaySnapshot({ enabledMethods: ["cod"], defaultMethod: "cod" });
    });

    it("uses payment_methods.enabled_methods as the storefront gateway allowlist", async () => {
        mockGatewaySnapshot({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const config = await getCheckoutConfig(await createDb());

        expect(config.gateways.map((gateway) => gateway.id)).toEqual(["cod"]);
        expect(mocks.getPaymentGatewaySettingsSnapshot).toHaveBeenCalledWith(
            expect.anything(),
            undefined,
        );
        expect(config.unavailable).toBe(false);
        expect(config.checkoutReadiness.status).toBe("ready");
        expect(config.currency).toEqual({
            code: "BDT",
            symbol: "৳",
            decimalPlaces: 2,
        });
    });

    it("fails closed when persisted checkout currency is unsupported", async () => {
        mockGatewaySnapshot({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const config = await getCheckoutConfig(await createDb({}, undefined, {
            currency: { currencyCode: "USDT", currencySymbol: "₿" },
        }));

        expect(config.currency).toEqual({
            code: "BDT",
            symbol: "৳",
            decimalPlaces: 2,
        });
        expect(config.gateways).toEqual([
            expect.objectContaining({
                id: "cod",
                currencies: ["BDT"],
            }),
        ]);
    });

    it("does not advertise a gateway that cannot process the store currency", async () => {
        mocks.getPaymentGatewaySettingsSnapshot.mockResolvedValue({
            preferences: {
                enabledMethods: ["sslcommerz", "cod"],
                defaultMethod: "sslcommerz",
                hasExplicitEnabledMethods: true,
            },
            activePaymentMethods: {
                enabledMethods: ["sslcommerz", "cod"],
                defaultMethod: "sslcommerz",
            },
            settings: {
                stripe: null,
                sslcommerz: { enabled: true, sandbox: false, storeId: "store_real", storePassword: "real-password" },
                cod: { enabled: true },
            },
        });

        const config = await getCheckoutConfig(await createDb({}, undefined, {
            currency: { currencyCode: "USD", currencySymbol: "$" },
        }));

        expect(config.gateways.map((gateway) => gateway.id)).toEqual(["cod"]);
        expect(config.activeDefaultMethod).toBeUndefined();
        expect(config.unavailable).toBe(false);
    });

    it("publishes the active default only when it survives public gateway readiness", async () => {
        mockGatewaySnapshot({
            enabledMethods: ["stripe", "cod"],
            defaultMethod: "stripe",
        });

        const config = await getCheckoutConfig(await createDb());

        expect(config.gateways).toEqual([
            {
                id: "stripe",
                name: "Card Payment",
                flow: "card",
                currencies: ["BDT"],
                publishableKey: "pk_test_realishValue",
                testMode: true,
            },
            { id: "cod", name: "Cash on Delivery", flow: "cod", currencies: ["BDT"] },
        ]);
        expect(config.activeDefaultMethod).toBe("stripe");
    });

    it("preserves the merchant's saved payment-method presentation order", async () => {
        mockGatewaySnapshot({
            enabledMethods: ["cod", "stripe"],
            defaultMethod: "stripe",
        });

        const config = await getCheckoutConfig(await createDb());

        expect(config.gateways.map((gateway) => gateway.id)).toEqual(["cod", "stripe"]);
        expect(config.activeDefaultMethod).toBe("stripe");
    });

    it("normalizes legacy public auth method values", async () => {
        mockGatewaySnapshot({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const legacyPhone = await getCheckoutConfig(await createDb({ authVerificationMethod: "phone" }));
        const unsupportedMandatory = await getCheckoutConfig(await createDb({ authVerificationMethod: "email_phone_mandatory" }));

	    expect(legacyPhone.authVerificationMethod).toBe("sms_otp");
	    expect(unsupportedMandatory.authVerificationMethod).toBe("email");
        expect(legacyPhone.customerAuthPolicy.otpChannels).toEqual(["sms"]);
	});

    it("publishes advanced customer auth policy for the storefront", async () => {
        mockGatewaySnapshot({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const config = await getCheckoutConfig(await createDb({}, {
            otpChannels: ["email", "whatsapp"],
            requiredContactFields: ["email", "phone"],
            optionalContactFields: [],
            defaultOtpChannel: "whatsapp",
        }));

        expect(config.customerAuthPolicy).toEqual({
            otpChannels: ["email", "whatsapp"],
            requiredContactFields: ["email", "phone"],
            optionalContactFields: [],
            defaultOtpChannel: "whatsapp",
        });
        expect(config.authVerificationMethod).toBe("whatsapp_otp");
    });

    it("still requires the individual gateway settings to be enabled", async () => {
        mockGatewaySnapshot({
            enabledMethods: ["stripe", "cod"],
            defaultMethod: "stripe",
        }, { ...readyStripe, enabled: false });

        const config = await getCheckoutConfig(await createDb());

        expect(config.gateways.map((gateway) => gateway.id)).toEqual(["cod"]);
        expect(config.activeDefaultMethod).toBeUndefined();
    });

    it("does not publish Stripe without a publishable key", async () => {
        mockGatewaySnapshot({
            enabledMethods: ["stripe", "cod"],
            defaultMethod: "stripe",
        }, { ...readyStripe, publishableKey: "" });

        const config = await getCheckoutConfig(await createDb());

        expect(config.gateways.map((gateway) => gateway.id)).toEqual(["cod"]);
    });

    it("does not publish COD as a partial-payment checkout gateway", async () => {
        mockGatewaySnapshot({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const config = await getCheckoutConfig(await createDb({
            partialPaymentEnabled: true,
            partialPaymentAmount: 200,
        }));

        expect(config.gateways).toEqual([]);
        expect(config.partialPaymentEnabled).toBe(true);
        expect(config.unavailable).toBe(true);
    });

    it("publishes unavailable config when there is no active shipping method", async () => {
        mockGatewaySnapshot({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const config = await getCheckoutConfig(await createDb({}, undefined, {
            activeShippingRows: [],
        }));

        expect(config.unavailable).toBe(true);
        expect(config.gateways).toEqual([]);
        expect(config.checkoutReadiness).toMatchObject({
            status: "incomplete",
            hasActiveShippingMethod: false,
            hasActiveDeliveryHierarchy: true,
        });
        expect(config.checkoutReadiness.issues).toContainEqual(
            expect.objectContaining({ message:            "Add at least one active shipping method before checkout can accept orders.", }),
        );
        expect(mocks.getPaymentGatewaySettingsSnapshot).not.toHaveBeenCalled();
    });

    it("publishes unavailable config when there is no active city-zone hierarchy", async () => {
        mockGatewaySnapshot({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const config = await getCheckoutConfig(await createDb({}, undefined, {
            activeHierarchyRows: [],
        }));

        expect(config.unavailable).toBe(true);
        expect(config.gateways).toEqual([]);
        expect(config.checkoutReadiness).toMatchObject({
            status: "incomplete",
            hasActiveShippingMethod: true,
            hasActiveDeliveryHierarchy: false,
        });
        expect(config.checkoutReadiness.issues).toContainEqual(
            expect.objectContaining({ message:            "Add at least one active city with an active zone before checkout can accept orders.", }),
        );
        expect(mocks.getPaymentGatewaySettingsSnapshot).not.toHaveBeenCalled();
    });

    it("fails closed when guest checkout is disabled without usable customer sign-in", async () => {
        mockGatewaySnapshot({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const config = await getCheckoutConfig(await createDb({
            guestCheckoutEnabled: false,
        }));

        expect(config.unavailable).toBe(true);
        expect(config.gateways).toEqual([]);
        expect(config.checkoutReadiness).toMatchObject({
            status: "incomplete",
            customerSignInRequired: true,
            hasUsableCustomerSignIn: false,
        });
        expect(config.checkoutReadiness.issues).toContainEqual(
            expect.objectContaining({ message:            "Configure a usable customer sign-in verification channel before requiring customer accounts at checkout.", }),
        );
        expect(mocks.getPaymentGatewaySettingsSnapshot).not.toHaveBeenCalled();
    });

    it("rejects when payment-method settings cannot be read", async () => {
        mocks.getPaymentGatewaySettingsSnapshot.mockRejectedValue(new Error("settings unavailable"));

        await expect(getCheckoutConfig(await createDb())).rejects.toThrow(
            "settings unavailable",
        );
    });

});
