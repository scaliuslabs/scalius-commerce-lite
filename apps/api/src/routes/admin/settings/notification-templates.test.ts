import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { errorResponseFromError } from "../../../utils/api-response";

const transport = vi.hoisted(() => ({ sendEmail: vi.fn(), sendSms: vi.fn(), getActiveSmsProvider: vi.fn() }));
vi.mock("@scalius/core/integrations/email", () => ({ sendEmail: transport.sendEmail }));
vi.mock("@scalius/core/integrations/sms", () => ({ getActiveSmsProvider: transport.getActiveSmsProvider }));

import { defaultNotificationTemplates } from "@scalius/core/modules/notifications/browser";

const DEFAULTS = defaultNotificationTemplates("en");
import { notificationTemplatesRoutes } from "./notification-templates";

function createTestApp(options: { rateLimited?: boolean } = {}) {
    const { db, sqlite } = createSqliteD1Database();
    sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('business', 'document', ?, 'json', 'business')")
        .run(JSON.stringify({ companyName: "Nokshi Kantha" }));
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin/settings");
    const limit = vi.fn(async () => ({ success: !options.rateLimited }));
    const env = {
        CREDENTIAL_ENCRYPTION_KEY: "credential-key",
        PUBLIC_API_BASE_URL: "https://api.shop.test",
        RL_STRICT: { limit },
    } as unknown as Env;
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db);
        c.set("user", { id: "staff_1", name: "Owner", email: "owner@shop.test" });
        await next();
    });
    app.route("/notification-channels/templates", notificationTemplatesRoutes);
    const request = async (path: string, method = "GET", body?: unknown) => {
        const response = await app.request(`/api/v1/admin/settings/notification-channels/templates${path}`, {
            method,
            ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        }, env);
        return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const stored = () => {
        const row = sqlite.prepare("SELECT value FROM settings WHERE category = 'notification_templates'").get() as { value: string } | undefined;
        return row ? JSON.parse(row.value) : null;
    };
    const activateLanguage = (code: string) => {
        sqlite.exec("UPDATE checkout_languages SET is_active = 0");
        sqlite.prepare(`INSERT INTO checkout_languages (id, name, code, is_active, is_default, language_data, field_visibility)
            VALUES (?, ?, ?, 1, 0, '{}', '{}')`).run(`lang_${code}`, code, code);
    };
    return { request, stored, limit, activateLanguage, sqlite };
}

describe("notification template routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        transport.sendEmail.mockResolvedValue({ success: true, provider: "mailpit" });
        transport.sendSms.mockResolvedValue({ success: true, providerRef: "sms_1" });
        transport.getActiveSmsProvider.mockResolvedValue({ name: "smsnetbd", sendSms: transport.sendSms });
    });

    it("serves the defaults at revision 0, then stores only what the merchant changed", async () => {
        const { request, stored } = createTestApp();
        const initial = await request("");
        expect(initial.body.data.revision).toBe(0);
        expect(initial.body.data.language).toBe("en");
        expect(initial.body.data.store).toEqual({ name: "Nokshi Kantha", logoUrl: null, storefrontUrl: null, nameFromAddress: false });
        expect(initial.body.data.templates.sms.order_shipped).toEqual(DEFAULTS.sms.order_shipped);

        const saved = await request("", "PUT", {
            event: "order_confirmed",
            email: DEFAULTS.email.order_confirmed,
            sms: { body: "{{customer_name}}, অর্ডার {{order_number}} কনফার্ম হয়েছে। মোট {{order_total}}।" },
            expectedRevision: 0,
        });

        expect(saved.status).toBe(200);
        expect(saved.body.data.revision).toBe(1);
        expect(saved.body.data.templates.sms.order_confirmed.body).toContain("কনফার্ম");
        expect(stored()).toEqual({
            email: {},
            sms: { order_confirmed: { body: "{{customer_name}}, অর্ডার {{order_number}} কনফার্ম হয়েছে। মোট {{order_total}}।" } },
        });

        // Resetting to the default removes the stored copy.
        await request("", "PUT", { event: "order_confirmed", sms: DEFAULTS.sms.order_confirmed, expectedRevision: 1 });
        expect(stored()).toEqual({ email: {}, sms: {} });
    });

    it("serves the Bangla defaults for a Bangla checkout and doesn't store them when saved unchanged", async () => {
        const { request, stored, activateLanguage } = createTestApp();
        activateLanguage("bn-BD");
        const bn = defaultNotificationTemplates("bn");
        const initial = await request("");
        expect(initial.body.data.language).toBe("bn");
        expect(initial.body.data.templates.email.order_created).toEqual(bn.email.order_created);

        await request("", "PUT", { event: "order_created", email: bn.email.order_created, sms: bn.sms.order_created, expectedRevision: 0 });
        expect(stored()).toEqual({ email: {}, sms: {} });
    });

    it("rejects variables the event can't fill, naming them on the field", async () => {
        const { request, stored } = createTestApp();

        const { status, body } = await request("", "PUT", {
            event: "order_confirmed",
            email: { subject: "Order {{order_number}}", body: "Tracking {{tracking_id}} by {{ courier }}" },
            expectedRevision: 0,
        });

        expect(status).toBe(400);
        expect(body.error.details.issues).toEqual([{
            path: ["email", "body"],
            message: "{{tracking_id}}, {{courier}} aren't variables this message can use.",
        }]);
        expect(stored()).toBeNull();
    });

    it("refuses a stale save with a revision conflict", async () => {
        const { request } = createTestApp();
        await request("", "PUT", { event: "order_created", sms: { body: "Got it, {{customer_name}}." }, expectedRevision: 0 });

        const { status, body } = await request("", "PUT", {
            event: "order_created",
            sms: { body: "Thanks {{customer_name}}." },
            expectedRevision: 0,
        });

        expect(status).toBe(409);
        expect(body.error).toMatchObject({ code: "SETTINGS_REVISION_CONFLICT", details: { expectedRevision: 0, currentRevision: 1 } });
    });

    it("rejects an SMS body over 1,000 characters", async () => {
        const { request } = createTestApp();
        expect((await request("", "PUT", { event: "order_created", sms: { body: "a".repeat(1001) }, expectedRevision: 0 })).status).toBe(400);
    });

    it("sends a test email of the draft to the signed-in staff member, with sample data", async () => {
        const { request } = createTestApp();

        const { status, body } = await request("/test", "POST", {
            channel: "email",
            event: "order_shipped",
            subject: "{{store_name}}: order {{order_number}} is out for delivery",
            body: "Hi {{customer_name}} <b>\n\nTracking: {{tracking_id}}",
        });

        expect(status).toBe(200);
        expect(body.data).toEqual({ sentTo: "owner@shop.test" });
        const email = transport.sendEmail.mock.calls[0]![0];
        expect(email.to).toBe("owner@shop.test");
        expect(email.subject).toBe("Nokshi Kantha: order #1001 is out for delivery");
        expect(email.html).toContain("Hi Rahim Uddin &lt;b&gt;");
        expect(email.html).toContain("Tracking: SF12345678");
    });

    it("names an unnamed store by its Store URL host and keeps the test subject when a variable is empty", async () => {
        const { request, sqlite } = createTestApp();
        sqlite.exec("DELETE FROM settings WHERE category = 'business'");

        await request("/test", "POST", {
            channel: "email", event: "order_created", subject: "R2-SET B {{order_number}} {{store_name}}", body: "Hi",
        });
        expect(transport.sendEmail.mock.calls[0]![0].subject).toBe("R2-SET B #1001");

        sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('platform', 'document', ?, 'json', 'platform')")
            .run(JSON.stringify({ storefrontUrl: "https://storefront.scalius.com" }));
        const { body } = await request("");
        expect(body.data.store).toMatchObject({ name: "storefront.scalius.com", nameFromAddress: true });
        await request("/test", "POST", {
            channel: "email", event: "order_created", subject: "{{store_name}}: {{order_number}}", body: "Hi",
        });
        expect(transport.sendEmail.mock.calls[1]![0]).toMatchObject({
            subject: "storefront.scalius.com: #1001",
            fromName: "storefront.scalius.com",
        });
    });

    it("sends a test SMS to a Bangla-digit number normalised to 01XXXXXXXXX", async () => {
        const { request } = createTestApp();

        const { status, body } = await request("/test", "POST", {
            channel: "sms",
            event: "order_created",
            body: "{{customer_name}}, অর্ডার {{order_number}} পেয়েছি।",
            phone: "০১৭১২-৩৪৫৬৭৮",
        });

        expect(status).toBe(200);
        expect(body.data).toEqual({ sentTo: "01712345678" });
        expect(transport.sendSms).toHaveBeenCalledWith({
            to: "+8801712345678",
            message: "Rahim Uddin, অর্ডার #1001 পেয়েছি।",
        });
    });

    it("rejects a non-Bangladesh mobile number on the phone field", async () => {
        const { request } = createTestApp();

        const { status, body } = await request("/test", "POST", {
            channel: "sms", event: "order_created", body: "Hi", phone: "12345",
        });

        expect(status).toBe(400);
        expect(body.error.details.issues[0].path).toEqual(["phone"]);
        expect(transport.sendSms).not.toHaveBeenCalled();
    });

    it("rate-limits test sends per staff member", async () => {
        const { request, limit } = createTestApp({ rateLimited: true });

        const { status } = await request("/test", "POST", {
            channel: "email", event: "order_created", subject: "Hi", body: "Hi",
        });

        expect(status).toBe(429);
        expect(limit).toHaveBeenCalledTimes(1);
        expect(transport.sendEmail).not.toHaveBeenCalled();
    });
});
