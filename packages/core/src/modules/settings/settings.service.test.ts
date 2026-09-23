import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { ValidationError } from "@scalius/core/errors";

const mocks = vi.hoisted(() => ({
    getEmailProviderReadiness: vi.fn(),
    getSmsProviderReadiness: vi.fn(),
    getWhatsAppCloudApiSettings: vi.fn(),
    getNotificationProviderBlock: vi.fn(),
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

import {
    getAdminNotificationChannels,
    getCurrencyConfig,
    getNotificationChannels,
    updateNotificationChannels,
} from "./settings.service";

type Harness = ReturnType<typeof createSqliteD1Database>;

function storeDocument(harness: Harness, category: string, value: unknown) {
    harness.sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES (?, 'document', ?, 'json', ?)")
        .run(`${category}_doc`, JSON.stringify(value), category);
    return harness.db;
}

function storedOrderChannels(harness: Harness): Record<string, string[]> | null {
    const row = harness.sqlite.prepare("SELECT value FROM settings WHERE category = 'notifications'").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value).orderChannels : null;
}

describe("buyer currency config", () => {
    it("normalizes a supported persisted code and derives its precision", async () => {
        const db = storeDocument(createSqliteD1Database(), "currency", {
            currencyCode: " jpy ",
            currencySymbol: "¥",
            usdExchangeRate: "150",
        });

        await expect(getCurrencyConfig(db)).resolves.toEqual({
            code: "JPY",
            symbol: "¥",
            usdExchangeRate: 150,
            decimalPlaces: 0,
        });
    });

    it("fails closed to BDT when the persisted code is unsupported", async () => {
        const db = storeDocument(createSqliteD1Database(), "currency", {
            currencyCode: "USDT",
            currencySymbol: "₿",
            usdExchangeRate: "999",
        });

        await expect(getCurrencyConfig(db)).resolves.toEqual({
            code: "BDT",
            symbol: "৳",
            usdExchangeRate: 1,
            decimalPlaces: 2,
        });
    });
});

function createSettingsDb(orderChannels?: string): Harness {
    const harness = createSqliteD1Database();
    if (orderChannels) storeDocument(harness, "notifications", { orderChannels: JSON.parse(orderChannels) });
    return harness;
}

describe("notification channel settings", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSmsProviderReadiness.mockResolvedValue({
            status: "ready",
            issues: [],
            activeProvider: "gennet",
        });
        mocks.getEmailProviderReadiness.mockResolvedValue({
            status: "ready",
            issues: [],
            provider: "cloudflare",
        });
        mocks.getWhatsAppCloudApiSettings.mockResolvedValue({
            accessTokenConfigured: true,
            phoneNumberId: "12345",
        });
        mocks.getNotificationProviderBlock.mockResolvedValue(null);
    });

    it("strips legacy customer push from reads", async () => {
        const db = createSettingsDb(JSON.stringify({
            order_created: ["email", "push"],
        }));

        await expect(getNotificationChannels(db.db)).resolves.toMatchObject({
            order_created: ["email"],
        });
    });

    it("adds new notification events with email defaults when reading older saved settings", async () => {
        const db = createSettingsDb(JSON.stringify({
            order_created: ["email"],
        }));

        await expect(getNotificationChannels(db.db)).resolves.toMatchObject({
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

        await expect(getAdminNotificationChannels(db.db)).resolves.toMatchObject({
            order_created: ["push"],
            order_cancelled: ["push"],
            support_request_submitted: ["push"],
            support_request_status_updated: [],
            order_delivered: [],
        });
    });

    it("rejects customer push notification saves until customer push exists end to end", async () => {
        const db = createSettingsDb();
        const before = storedOrderChannels(db);

        await expect(updateNotificationChannels(db.db, {
            order_created: ["email", "push"],
        })).rejects.toMatchObject({
            name: "ValidationError",
            message: "Customer push notifications are not implemented yet. Use Email, SMS, or WhatsApp for customer order notifications.",
        });

        expect(mocks.getSmsProviderReadiness).not.toHaveBeenCalled();
        expect(storedOrderChannels(db)).toEqual(before);
    });

    it("rejects SMS notification saves before the active provider is ready", async () => {
        mocks.getSmsProviderReadiness.mockResolvedValueOnce({
            status: "incomplete",
            issues: [{
                code: "missing_sms_provider_credentials",
                message: "No active SMS provider selected",
            }],
            activeProvider: null,
        });
        const db = createSettingsDb();
        const before = storedOrderChannels(db);

        const promise = updateNotificationChannels(db.db, {
            order_created: ["email", "sms"],
        }, "credential-key");

        await expect(promise).rejects.toBeInstanceOf(ValidationError);
        await expect(promise).rejects.toThrow("Configure an active SMS provider before enabling SMS order notifications.");

        expect(storedOrderChannels(db)).toEqual(before);
    });

    it("rejects email notification saves before the email provider is ready", async () => {
        mocks.getEmailProviderReadiness.mockResolvedValueOnce({
            status: "incomplete",
            issues: [{
                code: "missing_email_provider_credentials",
                message: "Configure Cloudflare Email or save a Resend API key before enabling email delivery.",
            }],
            provider: "cloudflare",
        });
        const db = createSettingsDb(JSON.stringify({ order_created: [] }));
        const before = storedOrderChannels(db);

        const promise = updateNotificationChannels(db.db, {
            order_created: ["email"],
        }, "credential-key");

        await expect(promise).rejects.toBeInstanceOf(ValidationError);
        await expect(promise).rejects.toThrow("Configure Cloudflare Email or save a Resend API key before enabling email delivery.");
        expect(storedOrderChannels(db)).toEqual(before);
    });

    it("saves SMS notifications when the active provider is ready", async () => {
        const db = createSettingsDb();

        const result = await updateNotificationChannels(db.db, {
            order_created: ["email", "sms"],
        }, "credential-key");

        expect(result.order_created).toEqual(["email", "sms"]);
        expect(mocks.getSmsProviderReadiness).toHaveBeenCalledWith(db.db, "credential-key");
        expect(storedOrderChannels(db)).toMatchObject({ order_created: ["email", "sms"] });
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
        const before = storedOrderChannels(db);

        await expect(updateNotificationChannels(db.db, {
            order_created: ["sms"],
        }, "credential-key")).rejects.toMatchObject({
            name: "ValidationError",
            message: "sms/gennet paused",
        });
        expect(storedOrderChannels(db)).toEqual(before);
    });

    it("allows unrelated changes when a previously enabled SMS provider is paused", async () => {
        mocks.getNotificationProviderBlock.mockImplementation(async (_db, options: { channel: string; provider: string }) =>
            options.channel === "sms" && options.provider === "gennet"
                ? { channel: "sms", provider: "gennet", reason: "HTTP 401 unauthorized", blockedAt: 1_782_684_758 }
                : null,
        );
        const saved = JSON.stringify({ order_created: ["sms"] });
        const db = createSettingsDb(saved);

        await expect(updateNotificationChannels(db.db, {
            order_created: ["sms"],
            order_confirmed: ["email"],
        }, "credential-key")).resolves.toMatchObject({
            order_created: ["sms"],
            order_confirmed: ["email"],
        });

        expect(mocks.getSmsProviderReadiness).not.toHaveBeenCalled();
        expect(storedOrderChannels(db)).toMatchObject({ order_created: ["sms"], order_confirmed: ["email"] });
    });

    it("still rejects newly enabling a paused SMS provider", async () => {
        mocks.getNotificationProviderBlock.mockImplementation(async (_db, options: { channel: string; provider: string }) =>
            options.channel === "sms" && options.provider === "gennet"
                ? { channel: "sms", provider: "gennet", reason: "HTTP 401 unauthorized", blockedAt: 1_782_684_758 }
                : null,
        );
        const db = createSettingsDb(JSON.stringify({ order_created: [] }));
        const before = storedOrderChannels(db);

        await expect(updateNotificationChannels(db.db, {
            order_created: ["sms"],
        }, "credential-key")).rejects.toMatchObject({
            name: "ValidationError",
            message: "sms/gennet paused",
        });
        expect(storedOrderChannels(db)).toEqual(before);
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
        const before = storedOrderChannels(db);

        await expect(updateNotificationChannels(db.db, {
            order_created: ["whatsapp"],
        }, "credential-key")).rejects.toMatchObject({
            name: "ValidationError",
            message: "whatsapp/whatsapp paused",
        });
        expect(storedOrderChannels(db)).toEqual(before);
    });
});
