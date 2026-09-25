import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { errorResponseFromError } from "../../../utils/api-response";

// Provider readiness is external setup; the notifications document is real.
const mocks = vi.hoisted(() => ({
    getEmailProviderReadiness: vi.fn(),
    getSmsProviderReadiness: vi.fn(),
    getFirebaseServiceAccountReadiness: vi.fn(),
    getWhatsAppCloudApiSettings: vi.fn(),
    getNotificationProviderBlock: vi.fn(),
    clearNotificationProviderBlocks: vi.fn(),
}));

vi.mock("@scalius/core/integrations/sms", () => ({ getSmsProviderReadiness: mocks.getSmsProviderReadiness }));
vi.mock("@scalius/core/integrations/email", () => ({ getEmailProviderReadiness: mocks.getEmailProviderReadiness }));
vi.mock("@scalius/core/integrations/whatsapp", () => ({ getWhatsAppCloudApiSettings: mocks.getWhatsAppCloudApiSettings }));
vi.mock("@scalius/core/integrations/firebase/settings", () => ({
    getFirebaseServiceAccountReadiness: mocks.getFirebaseServiceAccountReadiness,
}));
vi.mock("@scalius/core/modules/notifications", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@scalius/core/modules/notifications")>()),
    clearNotificationProviderBlocks: mocks.clearNotificationProviderBlocks,
    describeNotificationProviderBlock: (block: { channel: string; provider: string }) =>
          `${block.channel}/${block.provider} paused`,
    getNotificationProviderBlock: mocks.getNotificationProviderBlock,
}));

import { ORDER_NOTIFICATION_TYPES } from "@scalius/core/modules/notifications/browser";
import { notificationChannelsRoutes } from "./notification-channels";

const rules = (channels: string[], override: Record<string, string[]> = {}) => ({
    ...Object.fromEntries(ORDER_NOTIFICATION_TYPES.map((event) => [event, channels])),
    ...override,
});

const ready = { status: "ready", issues: [] };
const notReady = (message: string) => ({ status: "incomplete", issues: [{ code: "missing", message }] });

function createTestApp() {
    const { db, sqlite } = createSqliteD1Database();
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin/settings");
    const env = { CREDENTIAL_ENCRYPTION_KEY: "credential-key" } as unknown as Env;
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db);
        await next();
    });
    app.route("/notification-channels", notificationChannelsRoutes);

    const request = async (path: string, method = "GET", body?: unknown) => {
        const response = await app.request(`/api/v1/admin/settings/notification-channels${path}`, {
            method,
            ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        }, env);
        return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const stored = () => {
        const row = sqlite.prepare("SELECT value, revision FROM settings WHERE category = 'notifications'").get() as
            { value: string; revision: number } | undefined;
        return row ? { ...JSON.parse(row.value), revision: row.revision } : null;
    };
    return { request, stored, env, db };
}

describe("notification settings routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getEmailProviderReadiness.mockResolvedValue({ ...ready, provider: "cloudflare" });
        mocks.getSmsProviderReadiness.mockResolvedValue({ ...notReady("No active SMS provider selected"), activeProvider: null });
        mocks.getFirebaseServiceAccountReadiness.mockResolvedValue(ready);
        mocks.getWhatsAppCloudApiSettings.mockResolvedValue({ accessTokenConfigured: false, phoneNumberId: "" });
        mocks.getNotificationProviderBlock.mockResolvedValue(null);
        mocks.clearNotificationProviderBlocks.mockResolvedValue(undefined);
    });

    it("returns customer rules, staff alerts, readiness and the revision in one read", async () => {
        const { request } = createTestApp();

        const { status, body } = await request("");

        expect(status).toBe(200);
        expect(body.data).toMatchObject({
            channels: { order_created: ["email"], support_request_submitted: ["email"] },
            adminChannels: { order_created: ["push"], order_delivered: [] },
            staffEmailRecipients: [],
            whatsappTemplate: { templateName: "order_status_update", languageCode: "en_US" },
            sms: { status: "incomplete", issues: [{ message: "No active SMS provider selected" }] },
            email: { status: "ready", issues: [] },
            whatsapp: { status: "incomplete" },
            push: { status: "ready" },
            revision: 0,
        });
    });

    it("reports a configured provider as not ready while its delivery is paused", async () => {
        mocks.getSmsProviderReadiness.mockResolvedValue({ ...ready, activeProvider: "smsnetbd" });
        mocks.getNotificationProviderBlock.mockImplementation(async (_db, { channel, provider }) =>
            channel === "sms" && provider === "smsnetbd" ? { channel, provider, reason: "401", blockedAt: 1 } : null);
        const { request } = createTestApp();

        const { body } = await request("");

        expect(body.data.sms).toEqual({
            status: "incomplete",
            issues: [expect.objectContaining({ message: "sms/smsnetbd paused" })],
        });
    });

    it("saves customer rules and the WhatsApp template in one revisioned write", async () => {
        mocks.getWhatsAppCloudApiSettings.mockResolvedValue({ accessTokenConfigured: true, phoneNumberId: "123" });
        const { request, stored } = createTestApp();

        const { status, body } = await request("", "PUT", {
            channels: rules([], { order_created: ["whatsapp"] }),
            whatsappTemplate: { templateName: "order_update_bn", languageCode: "bn" },
            expectedRevision: 0,
        });

        expect(status).toBe(200);
        expect(body.data).toMatchObject({
            channels: { order_created: ["whatsapp"] },
            whatsappTemplate: { templateName: "order_update_bn", languageCode: "bn" },
            revision: 1,
        });
        expect(stored()).toMatchObject({ revision: 1, whatsappOrderTemplateName: "order_update_bn" });
        expect(mocks.clearNotificationProviderBlocks).toHaveBeenCalledWith(expect.anything(), { channel: "whatsapp" });
    });

    it("reads and saves the Wave B customer events, and keeps an older payload without them valid", async () => {
        mocks.getSmsProviderReadiness.mockResolvedValue({ ...ready, activeProvider: "smsnetbd" });
        const { request, stored } = createTestApp();

        const initial = await request("");
        expect(initial.body.data.channels).toMatchObject({
            order_digital_delivered: ["email", "sms"],
            gift_card_issued: ["email", "sms"],
            review_request: ["email"],
        });

        const saved = await request("", "PUT", {
            channels: rules(["email"], { review_request: ["email", "sms"], gift_card_issued: ["email"], order_digital_delivered: [] }),
            expectedRevision: 0,
        });
        expect(saved.status).toBe(200);
        expect(stored()).toMatchObject({
            orderChannels: { review_request: ["email", "sms"], gift_card_issued: ["email"], order_digital_delivered: [] },
        });

        expect((await request("", "PUT", { channels: rules(["email"]), expectedRevision: 1 })).status).toBe(200);
    });

    it("refuses WhatsApp for the Wave B customer events", async () => {
        const { request, stored } = createTestApp();

        const { status } = await request("", "PUT", {
            channels: rules(["email"], { gift_card_issued: ["whatsapp"] }),
            expectedRevision: 0,
        });

        expect(status).toBe(400);
        expect(stored()).toBeNull();
    });

    it("refuses a save from a stale page with a revision conflict and keeps the newer save", async () => {
        const { request, stored } = createTestApp();
        await request("", "PUT", { channels: rules(["email"], { order_created: [] }), expectedRevision: 0 });

        const { status, body } = await request("", "PUT", { channels: rules([]), expectedRevision: 0 });

        expect(status).toBe(409);
        expect(body.error).toMatchObject({
            code: "SETTINGS_REVISION_CONFLICT",
            details: { expectedRevision: 0, currentRevision: 1 },
        });
        expect(stored()).toMatchObject({ revision: 1, orderChannels: { order_created: [], order_confirmed: ["email"] } });
    });

    it.each([
        ["no revision", { channels: rules(["email"]) }],
        ["partial event maps", { channels: { order_created: ["email"] }, expectedRevision: 0 }],
        ["unsupported customer channels", { channels: rules(["email"], { order_created: ["push"] }), expectedRevision: 0 }],
        ["unknown event keys", { channels: { ...rules(["email"]), arbitrary_event: [] }, expectedRevision: 0 }],
    ])("rejects malformed customer settings: %s", async (_label, payload) => {
        const { request, stored } = createTestApp();

        expect((await request("", "PUT", payload)).status).toBe(400);
        expect(stored()).toBeNull();
    });

    it("saves staff email recipients normalised, and keeps push on while Firebase is down", async () => {
        mocks.getFirebaseServiceAccountReadiness.mockResolvedValue(notReady("Configure Firebase."));
        const { request, stored } = createTestApp();

        const { status, body } = await request("/admin-channels", "PUT", {
            channels: rules([], { order_created: ["push"] }),
            emailRecipients: [" Owner@Shop.test ", "owner@shop.test", "packing@shop.test"],
            expectedRevision: 0,
        });

        expect(status).toBe(200);
        expect(body.data).toMatchObject({
            staffEmailRecipients: ["owner@shop.test", "packing@shop.test"],
            adminChannels: { order_created: ["push"], order_cancelled: [] },
            revision: 1,
        });
        expect(stored()).toMatchObject({ staffEmailRecipients: ["owner@shop.test", "packing@shop.test"] });
    });

    it("reads and saves the Wave B staff alerts with push and email", async () => {
        const { request, stored } = createTestApp();

        const initial = await request("");
        expect(initial.body.data.adminChannels).toMatchObject({
            review_pending: ["push"],
            digital_keys_exhausted: ["push", "email"],
        });

        const { status } = await request("/admin-channels", "PUT", {
            channels: rules([], { review_pending: ["push", "email"], digital_keys_exhausted: ["email"] }),
            emailRecipients: [],
            expectedRevision: 0,
        });

        expect(status).toBe(200);
        expect(stored()).toMatchObject({ adminChannels: { review_pending: ["push", "email"], digital_keys_exhausted: ["email"] } });
    });

    it("refuses newly switching on push before Firebase is set up", async () => {
        mocks.getFirebaseServiceAccountReadiness.mockResolvedValue(notReady("Configure Firebase first."));
        const { request, stored } = createTestApp();

        const { status, body } = await request("/admin-channels", "PUT", {
            channels: rules([], { order_created: ["push"], order_delivered: ["push"] }),
            emailRecipients: [],
            expectedRevision: 0,
        });

        expect(status).toBe(400);
        expect(body.error.message).toBe("Configure Firebase first.");
        expect(stored()).toBeNull();
    });

    it("names the invalid staff email so the dashboard marks that field", async () => {
        const { request, stored } = createTestApp();

        const { status, body } = await request("/admin-channels", "PUT", {
            channels: rules([]),
            emailRecipients: ["owner@shop.test", "not-an-email"],
            expectedRevision: 0,
        });

        expect(status).toBe(400);
        expect(body.error.details.issues).toEqual([
            { path: ["emailRecipients", 1], message: "Enter an email like name@example.com." },
        ]);
        expect(stored()).toBeNull();
    });

    it("lets the second card save after the first once it has the newer revision", async () => {
        const { request } = createTestApp();
        const first = await request("", "PUT", { channels: rules(["email"]), expectedRevision: 0 });

        const staleStaff = await request("/admin-channels", "PUT", {
            channels: rules([]), emailRecipients: ["owner@shop.test"], expectedRevision: 0,
        });
        const freshStaff = await request("/admin-channels", "PUT", {
            channels: rules([]), emailRecipients: ["owner@shop.test"], expectedRevision: first.body.data.revision,
        });

        expect(staleStaff.status).toBe(409);
        expect(freshStaff.status).toBe(200);
        expect(freshStaff.body.data).toMatchObject({ channels: { order_created: ["email"] }, revision: 2 });
    });

    it.each([
        ["too many recipients", { channels: rules([]), emailRecipients: Array.from({ length: 11 }, (_, i) => `s${i}@shop.test`), expectedRevision: 0 }],
        ["unsupported staff channels", { channels: rules([], { order_created: ["email"] }), emailRecipients: [], expectedRevision: 0 }],
        ["partial event maps", { channels: { order_created: ["push"] }, emailRecipients: [], expectedRevision: 0 }],
    ])("rejects %s before writing", async (_label, payload) => {
        const { request, stored } = createTestApp();

        expect((await request("/admin-channels", "PUT", payload)).status).toBe(400);
        expect(stored()).toBeNull();
    });
});
