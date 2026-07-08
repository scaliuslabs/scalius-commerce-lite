import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORDER_NOTIFICATION_TYPES } from "@scalius/core/modules/notifications/notification-types";

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

    it("returns a compact redacted Admin MCP notification settings summary", async () => {
        mocks.getNotificationChannels.mockResolvedValueOnce({
            order_created: ["email", "sms", "whatsapp", "push", "resend"],
            order_confirmed: ["email"],
            support_request_submitted: [],
        });
        mocks.getAdminNotificationChannels.mockResolvedValueOnce({
            order_created: ["push", "email"],
            order_cancelled: ["push"],
        });
        mocks.getOrderWhatsAppTemplateSettings.mockResolvedValueOnce({
            templateName: "private_order_status_template",
            languageCode: "en_US",
        });
        mocks.getSmsProviderReadiness.mockResolvedValueOnce({
            activeProvider: "smsnetbd",
            configured: true,
            error: null,
        });
        mocks.isWhatsAppCloudApiConfigured.mockResolvedValueOnce(true);
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels/mcp-summary", {
            method: "GET",
        }, env);
        const body = await response.json() as {
            success: boolean;
            data: {
                adminNotificationSettingsSummary: {
                    source: Record<string, string>;
                    customer: {
                        supportedChannels: string[];
                        readiness: Record<string, { configured: boolean; ready: boolean; issueCount: number }>;
                        enabledEventCounts: Record<string, number>;
                        events: Array<{
                            type: string;
                            label: string;
                            enabledChannels: string[];
                            hasAnyChannel: boolean;
                        }>;
                        whatsappTemplate: { configured: boolean; languageConfigured: boolean };
                    };
                    merchant: {
                        supportedChannels: string[];
                        readiness: Record<string, { configured: boolean; ready: boolean; issueCount: number }>;
                        enabledEventCounts: Record<string, number>;
                        events: Array<{
                            type: string;
                            label: string;
                            enabledChannels: string[];
                            hasAnyChannel: boolean;
                        }>;
                    };
                    totals: Record<string, number>;
                    limits: Record<string, boolean>;
                };
            };
        };
        const summary = body.data.adminNotificationSettingsSummary;

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(summary).toMatchObject({
            source: {
                path: "/api/v1/admin/settings/notification-channels/mcp-summary",
                permission: "settings.general.view",
                version: "admin-notification-settings-summary:v1",
            },
            customer: {
                supportedChannels: ["email", "sms", "whatsapp"],
                readiness: {
                    email: { configured: true, ready: true, issueCount: 0 },
                    sms: { configured: true, ready: true, issueCount: 0 },
                    whatsapp: { configured: true, ready: true, issueCount: 0 },
                },
                enabledEventCounts: {
                    email: 2,
                    sms: 1,
                    whatsapp: 1,
                },
                whatsappTemplate: {
                    configured: true,
                    languageConfigured: true,
                },
            },
            merchant: {
                supportedChannels: ["push"],
                readiness: {
                    push: { configured: true, ready: true, issueCount: 0 },
                },
                enabledEventCounts: {
                    push: 2,
                },
            },
            totals: {
                orderEventCount: ORDER_NOTIFICATION_TYPES.length,
                customerEventsWithAnyChannel: 2,
                merchantEventsWithPush: 2,
                readinessIssueCount: 0,
            },
            limits: {
                includesCredentials: false,
                includesMaskedSecrets: false,
                includesProviderIdentifiers: false,
                includesRawProviderErrors: false,
                includesRecipients: false,
                includesOrderIds: false,
                includesDeliveryReceipts: false,
                canMutate: false,
            },
        });
        expect(summary.customer.events).toHaveLength(ORDER_NOTIFICATION_TYPES.length);
        expect(summary.customer.events.find((event) => event.type === "order_created")).toMatchObject({
            label: "Order Created",
            enabledChannels: ["email", "sms", "whatsapp"],
            hasAnyChannel: true,
        });
        expect(summary.merchant.events.find((event) => event.type === "order_created")).toMatchObject({
            label: "Order Created",
            enabledChannels: ["push"],
            hasAnyChannel: true,
        });
    });

    it("keeps Admin MCP summary failures compact and redacted", async () => {
        mocks.getNotificationChannels.mockResolvedValueOnce({
            order_created: ["email", "sms", "whatsapp"],
        });
        mocks.getAdminNotificationChannels.mockResolvedValueOnce({
            order_created: ["push"],
        });
        mocks.getOrderWhatsAppTemplateSettings.mockResolvedValueOnce({
            templateName: "secret_template_id",
            languageCode: "en_US",
        });
        mocks.getEmailProviderReadiness.mockResolvedValueOnce({
            configured: false,
            provider: "resend",
            sender: "merchant@example.com",
            senderConfigured: false,
            cloudflareBindingConfigured: false,
            resendConfigured: false,
            error: "Resend API rejected sk_live_secret_fixture for merchant@example.com",
            blockers: [
                "Resend API rejected sk_live_secret_fixture for merchant@example.com",
                "Sender merchant@example.com is invalid",
            ],
        });
        mocks.getSmsProviderReadiness.mockRejectedValueOnce(
            new Error("smsnetbd token token_secret failed"),
        );
        mocks.isWhatsAppCloudApiConfigured.mockResolvedValueOnce(true);
        mocks.getNotificationProviderBlock.mockImplementation(async (_db, options: { channel: string; provider: string }) =>
            options.channel === "whatsapp" && options.provider === "whatsapp"
                ? {
                    channel: "whatsapp",
                    provider: "whatsapp",
                    reason: "Graph API 401 token_secret template secret_template_id",
                    blockedAt: 1_782_684_758,
                }
                : null,
        );
        mocks.getFirebaseServiceAccountReadiness.mockRejectedValueOnce(
            new Error("project-private invalid_grant private_key secret"),
        );
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels/mcp-summary", {
            method: "GET",
        }, env);
        const body = await response.json() as {
            success: boolean;
            data: {
                adminNotificationSettingsSummary: {
                    customer: {
                        readiness: Record<string, { configured: boolean; ready: boolean; issueCount: number }>;
                    };
                    merchant: {
                        readiness: Record<string, { configured: boolean; ready: boolean; issueCount: number }>;
                    };
                    totals: Record<string, number>;
                };
            };
        };
        const summary = body.data.adminNotificationSettingsSummary;
        const serialized = JSON.stringify(body);

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(summary.customer.readiness).toMatchObject({
            email: { configured: false, ready: false, issueCount: 2 },
            sms: { configured: false, ready: false, issueCount: 1 },
            whatsapp: { configured: true, ready: false, issueCount: 1 },
        });
        expect(summary.merchant.readiness.push).toEqual({
            configured: false,
            ready: false,
            issueCount: 1,
        });
        expect(summary.totals.readinessIssueCount).toBe(5);
        expect(serialized).not.toContain("secret_template_id");
        expect(serialized).not.toContain("en_US");
        expect(serialized).not.toContain("sk_live_secret_fixture");
        expect(serialized).not.toContain("merchant@example.com");
        expect(serialized).not.toContain("smsnetbd");
        expect(serialized).not.toContain("token_secret");
        expect(serialized).not.toContain("Graph API 401");
        expect(serialized).not.toContain("invalid_grant");
        expect(serialized).not.toContain("private_key");
        expect(serialized).not.toContain("resend");
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
                channels: { order_created: ["email", "sms"] },
            }),
        }, env);
        const body = await response.json() as { success: boolean; error: { message: string } };

        expect(response.status).toBe(400);
        expect(body.success).toBe(false);
        expect(body.error.message).toContain("Configure an active SMS provider before enabling SMS order notifications.");
    });

    it("maps unsupported customer push saves to a customer-safe 400", async () => {
        mocks.updateNotificationChannels.mockRejectedValueOnce(
            new ValidationError("Customer push notifications are not implemented yet. Use Email, SMS, or WhatsApp for customer order notifications."),
        );
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/settings/notification-channels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                channels: { order_created: ["email", "push"] },
            }),
        }, env);
        const body = await response.json() as { success: boolean; error: { message: string } };

        expect(response.status).toBe(400);
        expect(body.success).toBe(false);
        expect(body.error.message).toContain("Customer push notifications are not implemented yet.");
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
                channels: { order_created: ["whatsapp"] },
                whatsappTemplate: {
                    templateName: "order_status_update",
                    languageCode: "en_US",
                },
            }),
        }, env);

        expect(response.status).toBe(200);
        expect(mocks.updateNotificationChannels).toHaveBeenCalledWith(
            { id: "db" },
            { order_created: ["whatsapp"] },
            "credential-key",
            env,
        );
        expect(mocks.clearNotificationProviderBlocks).toHaveBeenCalledWith(
            { id: "db" },
            { channel: "whatsapp" },
        );
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
                channels: { order_created: ["push"] },
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
                channels: { order_created: [] },
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
            { order_created: [] },
        );
    });
});
