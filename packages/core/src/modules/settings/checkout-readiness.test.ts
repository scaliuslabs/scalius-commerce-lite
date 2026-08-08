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

import {
    CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE,
    getCheckoutReadiness,
    getCustomerSignInReadiness,
} from "./checkout-readiness";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function createAuthDb(options: {
    guestCheckoutEnabled: boolean;
    authVerificationMethod?: string;
    policy?: Record<string, unknown>;
}) {
    const select = vi.fn().mockReturnValueOnce({
        from: () => ({
            limit: () => ({
                get: () => Promise.resolve({
                    guestCheckoutEnabled: options.guestCheckoutEnabled,
                    authVerificationMethod: options.authVerificationMethod ?? "email",
                }),
            }),
        }),
    });
    if (options.policy) {
        select.mockReturnValueOnce({
            from: () => ({
                where: () => ({
                    get: () => Promise.resolve({ value: JSON.stringify(options.policy) }),
                }),
            }),
        });
    } else {
        select.mockReturnValueOnce({
            from: () => ({
                where: () => ({ get: () => Promise.resolve(null) }),
            }),
        });
    }
    return { select };
}

describe("customer checkout sign-in readiness", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getEmailProviderReadiness.mockResolvedValue({ configured: false });
        mocks.getSmsProviderReadiness.mockResolvedValue({ configured: false });
        mocks.getWhatsAppCloudApiSettings.mockResolvedValue({});
    });

    it("starts delivery and sign-in reads together while preserving fail-closed readiness", async () => {
        const shipping = deferred<Array<{ id: string }>>();
        const hierarchy = deferred<Array<{ id: string }>>();
        const site = deferred<{
            guestCheckoutEnabled: boolean;
            authVerificationMethod: string;
        }>();
        const select = vi.fn()
            .mockReturnValueOnce({
                from: () => ({
                    where: () => ({ limit: () => shipping.promise }),
                }),
            })
            .mockReturnValueOnce({
                from: () => ({
                    where: () => ({ limit: () => hierarchy.promise }),
                }),
            })
            .mockReturnValueOnce({
                from: () => ({
                    limit: () => ({ get: () => site.promise }),
                }),
            });

        const resultPromise = getCheckoutReadiness({ select } as never, {});

        expect(select).toHaveBeenCalledTimes(3);
        shipping.resolve([{ id: "shipping_1" }]);
        hierarchy.resolve([{ id: "zone_1" }]);
        site.resolve({
            guestCheckoutEnabled: false,
            authVerificationMethod: "email",
        });

        await expect(resultPromise).resolves.toEqual({
            ready: false,
            hasActiveShippingMethod: true,
            hasActiveDeliveryHierarchy: true,
            customerSignInRequired: true,
            hasUsableCustomerSignIn: false,
            issues: [CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE],
        });
        expect(mocks.getEmailProviderReadiness).not.toHaveBeenCalled();
        expect(mocks.getSmsProviderReadiness).not.toHaveBeenCalled();
        expect(mocks.getWhatsAppCloudApiSettings).not.toHaveBeenCalled();
    });

    it("fails closed when accounts are required without the credential encryption key", async () => {
        const result = await getCustomerSignInReadiness(
            createAuthDb({ guestCheckoutEnabled: false }) as never,
            {},
        );

        expect(result).toEqual({
            customerSignInRequired: true,
            hasUsableCustomerSignIn: false,
        });
        expect(mocks.getEmailProviderReadiness).not.toHaveBeenCalled();
    });

    it("accepts a configured provider allowed by the saved customer auth policy", async () => {
        mocks.getSmsProviderReadiness.mockResolvedValue({ configured: true, activeProvider: "mimsms" });
        const db = createAuthDb({
            guestCheckoutEnabled: false,
            policy: {
                otpChannels: ["sms"],
                requiredContactFields: ["phone"],
                optionalContactFields: ["email"],
                defaultOtpChannel: "sms",
            },
        });

        await expect(getCustomerSignInReadiness(db as never, {
            encryptionKey: "credential-key",
        })).resolves.toEqual({
            customerSignInRequired: true,
            hasUsableCustomerSignIn: true,
        });
        expect(mocks.getSmsProviderReadiness).toHaveBeenCalledWith(db, "credential-key");
    });

    it("does not read optional sign-in providers on the public guest-checkout path", async () => {
        const result = await getCustomerSignInReadiness(
            createAuthDb({ guestCheckoutEnabled: true }) as never,
            {},
        );

        expect(result).toEqual({
            customerSignInRequired: false,
            hasUsableCustomerSignIn: true,
        });
        expect(mocks.getEmailProviderReadiness).not.toHaveBeenCalled();
    });

    it("lets the admin preview optional sign-in provider readiness before requiring accounts", async () => {
        const result = await getCustomerSignInReadiness(
            createAuthDb({ guestCheckoutEnabled: true }) as never,
            { inspectOptionalCustomerSignIn: true },
        );

        expect(result).toEqual({
            customerSignInRequired: false,
            hasUsableCustomerSignIn: false,
        });
    });
});
