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

function createDb() {
    const select = vi.fn()
        .mockReturnValueOnce({
            from: () => ({
                limit: () => Promise.resolve([{
                    guestCheckoutEnabled: true,
                    authVerificationMethod: "email",
                    checkoutMode: "all",
                    partialPaymentEnabled: false,
                    partialPaymentAmount: 0,
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
    });
});
