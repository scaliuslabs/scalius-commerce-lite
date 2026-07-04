import { beforeEach, describe, expect, it, vi } from "vitest";

import { ValidationError } from "@scalius/core/errors";

const mocks = vi.hoisted(() => ({
    getEmailProviderReadiness: vi.fn(),
    getSmsProviderReadiness: vi.fn(),
    getWhatsAppCloudApiSettings: vi.fn(),
    getNotificationProviderBlock: vi.fn(),
    upsertSetting: vi.fn(),
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

vi.mock("../notifications/notification-provider-health", () => ({
    describeNotificationProviderBlock: (block: { channel: string; provider: string; reason: string }) =>
        `${block.channel}/${block.provider} paused`,
    getNotificationProviderBlock: mocks.getNotificationProviderBlock,
}));

vi.mock("../payments/gateway-settings", () => ({
    upsertSetting: mocks.upsertSetting,
}));

import {
    getAdminNotificationChannels,
    getNotificationChannels,
    updateNotificationChannels,
} from "./settings.service";

function createSettingsDb(rowValue?: string) {
    return {
        select: vi.fn(() => ({
            from: vi.fn(() => ({
                where: vi.fn(() => ({
                    get: vi.fn(async () => rowValue ? { value: rowValue } : null),
                })),
            })),
        })),
    };
}

describe("notification channel settings", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSmsProviderReadiness.mockResolvedValue({
            activeProvider: "gennet",
            configured: true,
            error: null,
        });
        mocks.getEmailProviderReadiness.mockResolvedValue({
            configured: true,
            provider: "cloudflare",
            error: null,
        });
        mocks.getWhatsAppCloudApiSettings.mockResolvedValue({
            accessTokenConfigured: true,
            phoneNumberId: "12345",
        });
        mocks.getNotificationProviderBlock.mockResolvedValue(null);
        mocks.upsertSetting.mockResolvedValue(undefined);
    });

    it("strips legacy customer push from reads", async () => {
        const db = createSettingsDb(JSON.stringify({
            order_created: ["email", "push"],
        }));

        await expect(getNotificationChannels(db as never)).resolves.toMatchObject({
            order_created: ["email"],
        });
    });

    it("adds new notification events with email defaults when reading older saved settings", async () => {
        const db = createSettingsDb(JSON.stringify({
            order_created: ["email"],
        }));

        await expect(getNotificationChannels(db as never)).resolves.toMatchObject({
            order_created: ["email"],
            refund_processing: ["email"],
            refund_failed: ["email"],
            order_partially_refunded: ["email"],
            payment_balance_paid: ["email"],
            support_request_submitted: [],
            support_request_status_updated: ["email"],
        });
    });

    it("defaults admin push to new order, cancellation, and support request submissions only", async () => {
        const db = createSettingsDb();

        await expect(getAdminNotificationChannels(db as never)).resolves.toMatchObject({
            order_created: ["push"],
            order_cancelled: ["push"],
            support_request_submitted: ["push"],
            support_request_status_updated: [],
            order_delivered: [],
        });
    });

    it("rejects customer push notification saves until customer push exists end to end", async () => {
        const db = createSettingsDb();

        await expect(updateNotificationChannels(db as never, {
            order_created: ["email", "push"],
        })).rejects.toMatchObject({
            name: "ValidationError",
            message: "Customer push notifications are not implemented yet. Use Email, SMS, or WhatsApp for customer order notifications.",
        });

        expect(mocks.getSmsProviderReadiness).not.toHaveBeenCalled();
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
    });

    it("rejects SMS notification saves before the active provider is ready", async () => {
        mocks.getSmsProviderReadiness.mockResolvedValueOnce({
            activeProvider: null,
            configured: false,
            error: "No active SMS provider selected",
        });
        const db = createSettingsDb();

        const promise = updateNotificationChannels(db as never, {
            order_created: ["email", "sms"],
        }, "credential-key");

        await expect(promise).rejects.toBeInstanceOf(ValidationError);
        await expect(promise).rejects.toThrow("Configure an active SMS provider before enabling SMS order notifications.");

        expect(mocks.upsertSetting).not.toHaveBeenCalled();
    });

    it("rejects email notification saves before the email provider is ready", async () => {
        mocks.getEmailProviderReadiness.mockResolvedValueOnce({
            configured: false,
            provider: "cloudflare",
            error: "Configure Cloudflare Email or save a Resend API key before enabling email delivery.",
        });
        const db = createSettingsDb();

        const promise = updateNotificationChannels(db as never, {
            order_created: ["email"],
        }, "credential-key");

        await expect(promise).rejects.toBeInstanceOf(ValidationError);
        await expect(promise).rejects.toThrow("Configure Cloudflare Email or save a Resend API key before enabling email delivery.");
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
    });

    it("saves SMS notifications when the active provider is ready", async () => {
        const db = createSettingsDb();

        const result = await updateNotificationChannels(db as never, {
            order_created: ["email", "sms"],
        }, "credential-key");

        expect(result.order_created).toEqual(["email", "sms"]);
        expect(mocks.getSmsProviderReadiness).toHaveBeenCalledWith(db, "credential-key");
        const [, category, key, value] = mocks.upsertSetting.mock.calls[0] ?? [];
        expect({ category, key, channels: JSON.parse(String(value)) }).toMatchObject({
            category: "notifications",
            key: "order_channels",
            channels: {
                order_created: ["email", "sms"],
            },
        });
    });

    it("rejects SMS notification saves while the active provider is paused", async () => {
        mocks.getNotificationProviderBlock.mockImplementation(async (_db, options: { channel: string; provider: string }) =>
            options.channel === "sms" && options.provider === "gennet"
                ? {
                    channel: "sms",
                    provider: "gennet",
                    reason: "HTTP 401 unauthorized",
                    blockedAt: 1_782_684_758,
                }
                : null,
        );
        const db = createSettingsDb();

        await expect(updateNotificationChannels(db as never, {
            order_created: ["sms"],
        }, "credential-key")).rejects.toMatchObject({
            name: "ValidationError",
            message: "sms/gennet paused",
        });
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
    });

    it("rejects WhatsApp notification saves while Meta delivery is paused", async () => {
        mocks.getNotificationProviderBlock.mockImplementation(async (_db, options: { channel: string; provider: string }) =>
            options.channel === "whatsapp" && options.provider === "whatsapp"
                ? {
                    channel: "whatsapp",
                    provider: "whatsapp",
                    reason: "invalid token",
                    blockedAt: 1_782_684_758,
                }
                : null,
        );
        const db = createSettingsDb();

        await expect(updateNotificationChannels(db as never, {
            order_created: ["whatsapp"],
        }, "credential-key")).rejects.toMatchObject({
            name: "ValidationError",
            message: "whatsapp/whatsapp paused",
        });
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
    });
});
