import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../../utils/api-error";
import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
    getNotificationChannels: vi.fn(),
    updateNotificationChannels: vi.fn(),
    getAdminNotificationChannels: vi.fn(),
    updateAdminNotificationChannels: vi.fn(),
    getOrderWhatsAppTemplateSettings: vi.fn(),
    updateOrderWhatsAppTemplateSettings: vi.fn(),
    isWhatsAppCloudApiConfigured: vi.fn(),
    getNotificationProviderBlock: vi.fn(),
    getEmailProviderReadiness: vi.fn(),
    getSmsProviderReadiness: vi.fn(),
    getFirebaseServiceAccountReadiness: vi.fn(),
    clearNotificationProviderBlocks: vi.fn(),
}));

vi.mock("@scalius/core/modules/settings/settings.service", () => ({
    getNotificationChannels: mocks.getNotificationChannels,
    updateNotificationChannels: mocks.updateNotificationChannels,
    getAdminNotificationChannels: mocks.getAdminNotificationChannels,
    updateAdminNotificationChannels: mocks.updateAdminNotificationChannels,
    getOrderWhatsAppTemplateSettings: mocks.getOrderWhatsAppTemplateSettings,
    updateOrderWhatsAppTemplateSettings: mocks.updateOrderWhatsAppTemplateSettings,
    isWhatsAppCloudApiConfigured: mocks.isWhatsAppCloudApiConfigured,
}));

vi.mock("@scalius/core/integrations/sms", () => ({
    getSmsProviderReadiness: mocks.getSmsProviderReadiness,
}));

vi.mock("@scalius/core/integrations/email", () => ({
    getEmailProviderReadiness: mocks.getEmailProviderReadiness,
}));

vi.mock("@scalius/core/integrations/firebase/settings", () => ({
    getFirebaseServiceAccountReadiness: mocks.getFirebaseServiceAccountReadiness,
}));

vi.mock("@scalius/core/modules/notifications/notification-provider-health", () => ({
    clearNotificationProviderBlocks: mocks.clearNotificationProviderBlocks,
    describeNotificationProviderBlock: (block: { channel: string; provider: string; reason: string }) =>
        `${block.channel}/${block.provider} paused`,
    getNotificationProviderBlock: mocks.getNotificationProviderBlock,
}));

import { notificationChannelsRoutes } from "./notification-channels";

const completeAdminChannels = (override: Record<string, string[]> = {}) => ({
    order_created: ["push"],
    order_confirmed: [],
    order_processing: [],
    order_shipped: [],
    order_delivered: [],
    order_completed: [],
    order_cancelled: [],
    order_returned: [],
    refund_processing: [],
    refund_failed: [],
    order_refunded: [],
    order_partially_refunded: [],
    payment_balance_paid: [],
    support_request_submitted: [],
    support_request_status_updated: [],
    ...override,
});

const completeCustomerChannels = (override: Record<string, string[]> = {}) => ({
    order_created: ["email"],
    order_confirmed: ["email"],
    order_processing: ["email"],
    order_shipped: ["email"],
    order_delivered: ["email"],
    order_completed: ["email"],
    order_cancelled: ["email"],
    order_returned: ["email"],
    refund_processing: ["email"],
    refund_failed: ["email"],
    order_refunded: ["email"],
    order_partially_refunded: ["email"],
    payment_balance_paid: ["email"],
    support_request_submitted: [],
    support_request_status_updated: ["email"],
    ...override,
});

function createTestApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin/settings");
    const env = {
        CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    } as unknown as Env;

    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", { id: "db" } as never);
        await next();
    });
    app.route("/notification-channels", notificationChannelsRoutes);

    return { app, env };
}

describe("notification channel settings routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getNotificationChannels.mockResolvedValue({
            order_created: ["email"],
        });
        mocks.updateNotificationChannels.mockResolvedValue({
            order_created: ["email"],
        });
        mocks.getAdminNotificationChannels.mockResolvedValue({
            order_created: ["push"],
        });
        mocks.updateAdminNotificationChannels.mockResolvedValue({
            order_created: ["push"],
        });
        mocks.getOrderWhatsAppTemplateSettings.mockResolvedValue({
            templateName: "order_status_update",
            languageCode: "en_US",
        });
        mocks.updateOrderWhatsAppTemplateSettings.mockResolvedValue({
            templateName: "order_status_update",
            languageCode: "en_US",
        });
        mocks.isWhatsAppCloudApiConfigured.mockResolvedValue(false);
        mocks.getEmailProviderReadiness.mockResolvedValue({
            configured: true,
            provider: "cloudflare",
            error: null,
        });
        mocks.getSmsProviderReadiness.mockResolvedValue({
            activeProvider: null,
            configured: false,
            error: "No active SMS provider selected",
        });
        mocks.getNotificationProviderBlock.mockResolvedValue(null);
        mocks.getFirebaseServiceAccountReadiness.mockResolvedValue({
            configured: true,
            error: null,
            source: "settings",
        });
        mocks.clearNotificationProviderBlocks.mockResolvedValue(undefined);
    });

    it("returns SMS readiness with customer notification channels", async () => {
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels", {
            method: "GET",
        }, env);
        const body = await response.json() as {
            success: boolean;
            data: {
                smsProviderConfigured: boolean;
                smsProviderError: string | null;
                emailConfigured: boolean;
                emailError: string | null;
                whatsappConfigured: boolean;
            };
        };

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            success: true,
            data: {
                smsProviderConfigured: false,
                smsProviderError: "No active SMS provider selected",
                emailConfigured: true,
                emailError: null,
                whatsappConfigured: false,
            },
        });
        expect(mocks.getEmailProviderReadiness).toHaveBeenCalledWith({
            db: { id: "db" },
            encryptionKey: "credential-key",
            env,
        });
        expect(mocks.getSmsProviderReadiness).toHaveBeenCalledWith({ id: "db" }, "credential-key");
    });

    it("reports configured SMS providers as unready while delivery is paused", async () => {
        mocks.getSmsProviderReadiness.mockResolvedValueOnce({
            activeProvider: "smsnetbd",
            configured: true,
            error: null,
        });
        mocks.getNotificationProviderBlock.mockImplementation(async (_db, options: { channel: string; provider: string }) =>
            options.channel === "sms" && options.provider === "smsnetbd"
                ? {
                    channel: "sms",
                    provider: "smsnetbd",
                    reason: "error=405: Authorization required",
                    blockedAt: 1_782_684_758,
                }
                : null,
        );
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels", {
            method: "GET",
        }, env);
        const body = await response.json() as {
            data: {
                smsProviderConfigured: boolean;
                smsProviderError: string | null;
            };
        };

        expect(response.status).toBe(200);
        expect(body.data.smsProviderConfigured).toBe(false);
        expect(body.data.smsProviderError).toBe("sms/smsnetbd paused");
    });

    it("reports email notifications as unready while provider delivery is paused", async () => {
        mocks.getNotificationProviderBlock.mockImplementation(async (_db, options: { channel: string; provider: string }) =>
            options.channel === "email" && options.provider === "cloudflare"
                ? {
                    channel: "email",
                    provider: "cloudflare",
                    reason: "Resend API error 401",
                    blockedAt: 1_782_684_758,
                }
                : null,
        );
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels", {
            method: "GET",
        }, env);
        const body = await response.json() as {
            data: {
                emailConfigured: boolean;
                emailError: string | null;
            };
        };

        expect(response.status).toBe(200);
        expect(body.data.emailConfigured).toBe(false);
        expect(body.data.emailError).toBe("email/cloudflare paused");
    });

    it("maps unready SMS channel saves to a customer-safe 400", async () => {
        mocks.updateNotificationChannels.mockRejectedValueOnce(
            new ValidationError("Configure an active SMS provider before enabling SMS order notifications. No active SMS provider selected"),
        );
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                channels: completeCustomerChannels({ order_created: ["email", "sms"] }),
            }),
        }, env);
        const body = await response.json() as { success: boolean; error: { message: string } };

        expect(response.status).toBe(400);
        expect(body.success).toBe(false);
        expect(body.error.message).toContain("Configure an active SMS provider before enabling SMS order notifications.");
    });

    it("rejects unsupported customer push before mutation", async () => {
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                channels: completeCustomerChannels({ order_created: ["email", "push"] }),
            }),
        }, env);
        const body = await response.json() as { success: boolean; error: { message: string } };

        expect(response.status).toBe(400);
        expect(body.success).toBe(false);
        expect(body.error.message).toContain("email");
        expect(mocks.updateNotificationChannels).not.toHaveBeenCalled();
    });

    it("clears paused WhatsApp sends after saving the order template", async () => {
        mocks.updateNotificationChannels.mockImplementationOnce(async () => {
            expect(mocks.updateOrderWhatsAppTemplateSettings).toHaveBeenCalledWith(
                { id: "db" },
                {
                    templateName: "order_status_update",
                    languageCode: "en_US",
                },
            );
            expect(mocks.clearNotificationProviderBlocks).toHaveBeenCalledWith(
                { id: "db" },
                { channel: "whatsapp" },
            );
            return { order_created: ["whatsapp"] };
        });
        mocks.isWhatsAppCloudApiConfigured.mockResolvedValue(true);
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                channels: completeCustomerChannels({
                    order_created: ["whatsapp"],
                    order_confirmed: [],
                    order_processing: [],
                    order_shipped: [],
                    order_delivered: [],
                    order_completed: [],
                    order_cancelled: [],
                    order_returned: [],
                    refund_processing: [],
                    refund_failed: [],
                    order_refunded: [],
                    order_partially_refunded: [],
                    payment_balance_paid: [],
                    support_request_status_updated: [],
                }),
                whatsappTemplate: {
                    templateName: "order_status_update",
                    languageCode: "en_US",
                },
            }),
        }, env);

        expect(response.status).toBe(200);
        expect(mocks.updateNotificationChannels).toHaveBeenCalledWith(
            { id: "db" },
            completeCustomerChannels({
                order_created: ["whatsapp"],
                order_confirmed: [], order_processing: [], order_shipped: [], order_delivered: [],
                order_completed: [], order_cancelled: [], order_returned: [], refund_processing: [],
                refund_failed: [], order_refunded: [], order_partially_refunded: [], payment_balance_paid: [],
                support_request_status_updated: [],
            }),
            "credential-key",
            env,
        );
        expect(mocks.clearNotificationProviderBlocks).toHaveBeenCalledWith(
            { id: "db" },
            { channel: "whatsapp" },
        );
    });

    it.each([
        ["partial event maps", { channels: { order_created: ["email"] } }],
        ["unsupported customer channels", { channels: completeCustomerChannels({ order_created: ["push"] }) }],
        ["unknown event keys", { channels: { ...completeCustomerChannels(), arbitrary_event: [] } }],
    ])("rejects malformed customer notification settings: %s", async (_label, payload) => {
        const { app, env } = createTestApp();
        const response = await app.request("/api/v1/admin/settings/notification-channels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }, env);

        expect(response.status).toBe(400);
        expect(mocks.updateNotificationChannels).not.toHaveBeenCalled();
    });

    it("returns Firebase push readiness with admin notification channels", async () => {
        mocks.getFirebaseServiceAccountReadiness.mockResolvedValueOnce({
            configured: false,
            error: "Configure Firebase service account credentials before enabling admin push notifications.",
            source: "none",
        });
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels/admin-channels", {
            method: "GET",
        }, env);
        const body = await response.json() as {
            success: boolean;
            data: {
                channels: Record<string, string[]>;
                pushConfigured: boolean;
                pushError: string | null;
            };
        };

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            success: true,
            data: {
                channels: { order_created: ["push"] },
                pushConfigured: false,
                pushError: "Configure Firebase service account credentials before enabling admin push notifications.",
            },
        });
        expect(mocks.getFirebaseServiceAccountReadiness).toHaveBeenCalledWith(
            { id: "db" },
            "credential-key",
            env,
        );
    });

    it("reports configured admin push as unready while FCM delivery is paused", async () => {
        mocks.getNotificationProviderBlock.mockResolvedValueOnce({
            channel: "push",
            provider: "fcm",
            reason: "invalid_grant service account disabled",
            blockedAt: 1_782_684_758,
        });
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels/admin-channels", {
            method: "GET",
        }, env);
        const body = await response.json() as {
            data: {
                pushConfigured: boolean;
                pushError: string | null;
            };
        };

        expect(response.status).toBe(200);
        expect(body.data.pushConfigured).toBe(false);
        expect(body.data.pushError).toBe("push/fcm paused");
    });

    it("rejects admin push saves when Firebase readiness is not configured", async () => {
        mocks.getFirebaseServiceAccountReadiness.mockResolvedValueOnce({
            configured: false,
            error: "Saved Firebase service account is not usable. Save a valid service account or disable admin push notifications.",
            source: "settings",
        });
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels/admin-channels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                channels: completeAdminChannels(),
            }),
        }, env);
        const body = await response.json() as { success: boolean; error: { message: string } };

        expect(response.status).toBe(400);
        expect(body.success).toBe(false);
        expect(body.error.message).toContain("Saved Firebase service account is not usable.");
        expect(mocks.updateAdminNotificationChannels).not.toHaveBeenCalled();
    });

    it("allows disabling admin push even when Firebase is not configured", async () => {
        mocks.getFirebaseServiceAccountReadiness.mockResolvedValueOnce({
            configured: false,
            error: "Configure Firebase service account credentials before enabling admin push notifications.",
            source: "none",
        });
        mocks.updateAdminNotificationChannels.mockResolvedValueOnce({
            order_created: [],
        });
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels/admin-channels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                channels: completeAdminChannels({ order_created: [] }),
            }),
        }, env);
        const body = await response.json() as { success: boolean; data: { channels: Record<string, string[]> } };

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            success: true,
            data: {
                channels: { order_created: [] },
                pushConfigured: false,
            },
        });
        expect(mocks.updateAdminNotificationChannels).toHaveBeenCalledWith(
            { id: "db" },
            completeAdminChannels({ order_created: [] }),
        );
    });

    it.each([
        ["partial event maps", { channels: { order_created: ["push"] } }],
        ["unsupported admin channels", { channels: completeAdminChannels({ order_created: ["email"] }) }],
        ["unknown event keys", { channels: { ...completeAdminChannels(), arbitrary_event: [] } }],
    ])("rejects %s before mutating notification settings", async (_label, payload) => {
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels/admin-channels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }, env);

        expect(response.status).toBe(400);
        expect(mocks.updateAdminNotificationChannels).not.toHaveBeenCalled();
    });
});
