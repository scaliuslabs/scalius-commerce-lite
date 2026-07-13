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

import { getCustomerSignInReadiness } from "./checkout-readiness";

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
