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
    getSmsProviderReadiness: vi.fn(),
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
        mocks.getSmsProviderReadiness.mockResolvedValue({
            activeProvider: null,
            configured: false,
            error: "No active SMS provider selected",
        });
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
                whatsappConfigured: boolean;
            };
        };

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            success: true,
            data: {
                smsProviderConfigured: false,
                smsProviderError: "No active SMS provider selected",
                whatsappConfigured: false,
            },
        });
        expect(mocks.getSmsProviderReadiness).toHaveBeenCalledWith({ id: "db" }, "credential-key");
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
});
