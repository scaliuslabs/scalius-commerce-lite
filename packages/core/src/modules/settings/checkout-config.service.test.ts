import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getRegisteredGateways: vi.fn(),
    getActivePaymentMethods: vi.fn(),
}));

vi.mock("../payments/gateway-registry", () => ({
    getRegisteredGateways: mocks.getRegisteredGateways,
}));

vi.mock("../payments/gateway-settings", () => ({
    getActivePaymentMethods: mocks.getActivePaymentMethods,
}));

import { getCheckoutConfig } from "./checkout-config.service";

function createDb(
    siteOverrides: Record<string, unknown> = {},
    customerAuthPolicy?: Record<string, unknown>,
    readiness: {
        activeShippingRows?: Array<{ id: string }>;
        activeHierarchyRows?: Array<{ id: string }>;
    } = {},
) {
    const select = vi.fn()
        .mockReturnValueOnce({
            from: () => ({
                limit: () => Promise.resolve([{
                    guestCheckoutEnabled: true,
                    authVerificationMethod: "email",
                    checkoutMode: "all",
                    partialPaymentEnabled: false,
                    partialPaymentAmount: 0,
                    ...siteOverrides,
                }]),
            }),
        })
        .mockReturnValueOnce({
            from: () => ({
                where: () => ({
                    all: () => Promise.resolve([
                        { key: "currency_code", value: "bdt" },
                        { key: "currency_symbol", value: "৳" },
                    ]),
                }),
            }),
        })
        .mockReturnValueOnce({
            from: () => ({
                where: () => ({
                    get: () => Promise.resolve(null),
                }),
            }),
        })
        .mockReturnValueOnce({
            from: () => ({
                where: () => ({
                    get: () => Promise.resolve(customerAuthPolicy ? { value: JSON.stringify(customerAuthPolicy) } : null),
                }),
            }),
        })
        .mockReturnValueOnce({
            from: () => ({
                where: () => ({
                    limit: () => Promise.resolve(readiness.activeShippingRows ?? [{ id: "sm_1" }]),
                }),
            }),
        })
        .mockReturnValueOnce({
            from: () => ({
                where: () => ({
                    limit: () => Promise.resolve(readiness.activeHierarchyRows ?? [{ id: "zone_1" }]),
                }),
            }),
        });

    return { select };
}

describe("getCheckoutConfig", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getRegisteredGateways.mockReturnValue([
            {
                id: "stripe",
                name: "Stripe",
                settingsCategory: "stripe",
                getSettings: vi.fn().mockResolvedValue({ enabled: true, publishableKey: "pk_test" }),
                getPublicConfig: (settings: Record<string, unknown>) => ({
                    publishableKey: settings.publishableKey,
                }),
                getCurrencies: () => ["bdt", "usd"],
            },
            {
                id: "cod",
                name: "Cash on Delivery",
                settingsCategory: "cod",
                getSettings: vi.fn().mockResolvedValue({ enabled: true }),
            },
        ]);
    });

    it("uses payment_methods.enabled_methods as the storefront gateway allowlist", async () => {
        mocks.getActivePaymentMethods.mockResolvedValue({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const config = await getCheckoutConfig(createDb() as never);

        expect(config.gateways.map((gateway) => gateway.id)).toEqual(["cod"]);
        expect(mocks.getActivePaymentMethods).toHaveBeenCalledWith(
            expect.anything(),
            undefined,
            undefined,
            { bypassMemoryCache: true },
        );
        expect(config.unavailable).toBe(false);
        expect(config.checkoutReadiness.ready).toBe(true);
    });

    it("publishes the active default only when it survives public gateway readiness", async () => {
        mocks.getActivePaymentMethods.mockResolvedValue({
            enabledMethods: ["stripe", "cod"],
            defaultMethod: "stripe",
        });

        const config = await getCheckoutConfig(createDb() as never);

        expect(config.gateways.map((gateway) => gateway.id)).toEqual(["stripe", "cod"]);
        expect(config.activeDefaultMethod).toBe("stripe");
    });

    it("normalizes legacy public auth method values", async () => {
        mocks.getActivePaymentMethods.mockResolvedValue({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const legacyPhone = await getCheckoutConfig(createDb({ authVerificationMethod: "phone" }) as never);
        const unsupportedMandatory = await getCheckoutConfig(createDb({ authVerificationMethod: "email_phone_mandatory" }) as never);

	    expect(legacyPhone.authVerificationMethod).toBe("sms_otp");
	    expect(unsupportedMandatory.authVerificationMethod).toBe("email");
        expect(legacyPhone.customerAuthPolicy.otpChannels).toEqual(["sms"]);
	});

    it("publishes advanced customer auth policy for the storefront", async () => {
        mocks.getActivePaymentMethods.mockResolvedValue({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const config = await getCheckoutConfig(createDb({}, {
            otpChannels: ["email", "whatsapp"],
            requiredContactFields: ["email", "phone"],
            optionalContactFields: [],
            defaultOtpChannel: "whatsapp",
        }) as never);

        expect(config.customerAuthPolicy).toEqual({
            otpChannels: ["email", "whatsapp"],
            requiredContactFields: ["email", "phone"],
            optionalContactFields: [],
            defaultOtpChannel: "whatsapp",
        });
        expect(config.authVerificationMethod).toBe("whatsapp_otp");
    });

    it("still requires the individual gateway settings to be enabled", async () => {
        mocks.getActivePaymentMethods.mockResolvedValue({
            enabledMethods: ["stripe", "cod"],
            defaultMethod: "stripe",
        });
        const gateways = mocks.getRegisteredGateways();
        gateways[0].getSettings.mockResolvedValue({ enabled: false, publishableKey: "pk_test" });

        const config = await getCheckoutConfig(createDb() as never);

        expect(config.gateways.map((gateway) => gateway.id)).toEqual(["cod"]);
        expect(config.activeDefaultMethod).toBeUndefined();
        expect(gateways[0].getSettings).toHaveBeenCalledWith(
            expect.anything(),
            undefined,
            undefined,
            { bypassMemoryCache: true },
        );
    });

    it("does not publish Stripe without a publishable key", async () => {
        mocks.getActivePaymentMethods.mockResolvedValue({
            enabledMethods: ["stripe", "cod"],
            defaultMethod: "stripe",
        });
        const gateways = mocks.getRegisteredGateways();
        gateways[0].getSettings.mockResolvedValue({ enabled: true, publishableKey: "" });

        const config = await getCheckoutConfig(createDb() as never);

        expect(config.gateways.map((gateway) => gateway.id)).toEqual(["cod"]);
    });

    it("does not publish COD as a partial-payment checkout gateway", async () => {
        mocks.getActivePaymentMethods.mockResolvedValue({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const config = await getCheckoutConfig(createDb({
            partialPaymentEnabled: true,
            partialPaymentAmount: 200,
        }) as never);

        expect(config.gateways).toEqual([]);
        expect(config.partialPaymentEnabled).toBe(true);
        expect(config.unavailable).toBe(true);
    });

    it("publishes unavailable config when there is no active shipping method", async () => {
        mocks.getActivePaymentMethods.mockResolvedValue({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const config = await getCheckoutConfig(createDb({}, undefined, {
            activeShippingRows: [],
        }) as never);

        expect(config.unavailable).toBe(true);
        expect(config.gateways).toEqual([]);
        expect(config.checkoutReadiness).toMatchObject({
            ready: false,
            hasActiveShippingMethod: false,
            hasActiveDeliveryHierarchy: true,
        });
        expect(config.checkoutReadiness.issues).toContain(
            "Add at least one active shipping method before checkout can accept orders.",
        );
        expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    });

    it("publishes unavailable config when there is no active city-zone hierarchy", async () => {
        mocks.getActivePaymentMethods.mockResolvedValue({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        const config = await getCheckoutConfig(createDb({}, undefined, {
            activeHierarchyRows: [],
        }) as never);

        expect(config.unavailable).toBe(true);
        expect(config.gateways).toEqual([]);
        expect(config.checkoutReadiness).toMatchObject({
            ready: false,
            hasActiveShippingMethod: true,
            hasActiveDeliveryHierarchy: false,
        });
        expect(config.checkoutReadiness.issues).toContain(
            "Add at least one active city with an active zone before checkout can accept orders.",
        );
        expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    });

    it("rejects when payment-method settings cannot be read", async () => {
        mocks.getActivePaymentMethods.mockRejectedValue(new Error("settings unavailable"));

        await expect(getCheckoutConfig(createDb() as never)).rejects.toThrow(
            "settings unavailable",
        );
    });

    it("rejects when a candidate gateway setting read fails", async () => {
        mocks.getActivePaymentMethods.mockResolvedValue({
            enabledMethods: ["stripe", "cod"],
            defaultMethod: "stripe",
        });
        const gateways = mocks.getRegisteredGateways();
        gateways[0].getSettings.mockRejectedValue(new Error("stripe settings unavailable"));

        await expect(getCheckoutConfig(createDb() as never)).rejects.toThrow(
            "stripe settings unavailable",
        );
    });
});
