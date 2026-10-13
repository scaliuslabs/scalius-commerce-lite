// Storefront marketing routes on the real schema: storefront-server auth,
// native rate limits, the newsletter's identity and enumeration rules, the
// double opt-in confirmation reached only through the e-mail's token, and the
// signed unsubscribe link (preview changes nothing; tampered links do nothing).
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { deriveOptInToken, signUnsubscribeToken } from "@scalius/core/modules/customer-marketing";
import { UnauthorizedError } from "../utils/api-error";
import { errorResponseFromError } from "../utils/api-response";

vi.mock("../middleware/auth", () => ({
    authMiddleware: async (c: { req: { header: (name: string) => string | undefined } }, next: () => Promise<void>) => {
        if (c.req.header("Authorization") !== "Bearer storefront") throw new UnauthorizedError("Authentication required");
        await next();
    },
}));

const { marketingRoutes } = await import("./marketing");

const SECRET = "test-master-secret-that-is-long-enough-123456";

// Response bodies are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { data?: any; error?: any };

function createApp(options: { limited?: boolean } = {}) {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`INSERT INTO customers (id, name, phone, email, origin, account_claimed_at, phone_verified_at, email_verified_at)
        VALUES ('cust_acct', 'Karim', '+8801722222222', 'karim@example.com', 'account', 1, 1, 1)`);
    const sent: unknown[] = [];
    const limiter = { limit: async () => ({ success: !options.limited }) };
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db);
        c.env = {
            SCALIUS_SECRET: SECRET,
            RL_STRICT: limiter,
            RL_STANDARD: limiter,
            JOBS_QUEUE: { send: async (message: unknown) => { sent.push(message); } },
        } as unknown as Env;
        await next();
    });
    app.route("/marketing", marketingRoutes);
    const post = async (path: string, body: unknown, auth = true) => {
        const response = await app.request(`/api/v1/marketing${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.9", ...(auth ? { Authorization: "Bearer storefront" } : {}) },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() as Envelope };
    };
    return { sqlite, post, sent };
}

describe("storefront marketing routes", () => {
    it("serve only the storefront server and honour the native rate limit", async () => {
        expect((await createApp().post("/subscribe", { channels: ["sms"], phone: "01711111111" }, false)).status).toBe(401);
        expect((await createApp({ limited: true }).post("/subscribe", { channels: ["sms"], phone: "01711111111" })).status).toBe(429);
        expect((await createApp({ limited: true }).post("/unsubscribe", { token: "x" })).status).toBe(429);
    });

    it("subscribes with the same answer for known and unknown contacts, and confirms only with the e-mail's token", async () => {
        const { sqlite, post, sent } = createApp();
        const known = await post("/subscribe", { channels: ["sms", "email", "whatsapp"], phone: "01722222222", email: "karim@example.com", language: "bn" });
        const unknown = await post("/subscribe", { channels: ["sms", "email"], phone: "01755555555", email: "new@example.com" });
        expect(known).toEqual({ status: 200, body: { success: true, data: { result: "pending" } } });
        expect(unknown).toEqual({ status: 200, body: { success: true, data: { result: "pending" } } });
        expect((await post("/subscribe", { channels: ["sms"], phone: "01766666666" })).body.data).toEqual({ result: "subscribed" });
        expect((await post("/subscribe", { channels: ["sms"], phone: "01766666666", website: "spam" })).status).toBe(400);
        // Queue messages carry the outbox id only.
        expect(sent.every((message) => JSON.stringify(Object.keys(message as object)) === '["type","outboxId"]')).toBe(true);
        const pending = sqlite.prepare("SELECT customer_id, channel, state FROM customer_marketing_consents WHERE customer_id = 'cust_acct' ORDER BY channel").all();
        expect(pending).toEqual([
            { customer_id: "cust_acct", channel: "email", state: "pending" },
            { customer_id: "cust_acct", channel: "sms", state: "subscribed" },
            { customer_id: "cust_acct", channel: "whatsapp", state: "subscribed" },
        ]);
        const outbox = sqlite.prepare("SELECT payload FROM notification_outbox WHERE subject_id = 'cust_acct'").get() as { payload: string };
        const nonce = JSON.parse(outbox.payload).data.nonce as string;
        expect((await post("/confirm", { token: "A".repeat(43) })).body.data).toEqual({ status: "invalid" });
        const token = await deriveOptInToken({ SCALIUS_SECRET: SECRET }, { customerId: "cust_acct", nonce });
        expect((await post("/confirm", { token })).body.data).toEqual({ status: "confirmed" });
        expect((await post("/confirm", { token })).body.data).toEqual({ status: "invalid" });
        expect(sqlite.prepare("SELECT state FROM customer_marketing_consents WHERE customer_id = 'cust_acct' AND channel = 'email'").get()).toEqual({ state: "subscribed" });
    });

    it("previews and applies a signed unsubscribe link, ignoring tampered ones", async () => {
        const { sqlite, post } = createApp();
        await post("/subscribe", { channels: ["sms"], phone: "01722222222" });
        const token = await signUnsubscribeToken({ SCALIUS_SECRET: SECRET }, { customerId: "cust_acct", channel: "sms" });
        expect((await post("/unsubscribe/preview", { token })).body.data).toEqual({ valid: true, channel: "sms", status: "subscribed", contactMasked: "+88017•••••222" });
        expect(sqlite.prepare("SELECT state FROM customer_marketing_consents WHERE channel = 'sms'").get()).toEqual({ state: "subscribed" });
        const forged = token.replace(".sms.", ".email.");
        expect((await post("/unsubscribe/preview", { token: forged })).body.data).toEqual({ valid: false, channel: null, status: null, contactMasked: null });
        expect((await post("/unsubscribe", { token: forged })).body.data).toEqual({ status: "invalid", channel: null });
        expect((await post("/unsubscribe", { token })).body.data).toEqual({ status: "unsubscribed", channel: "sms" });
        expect((await post("/unsubscribe", { token })).body.data).toEqual({ status: "unsubscribed", channel: "sms" });
        expect(sqlite.prepare("SELECT state, source FROM customer_marketing_consents WHERE channel = 'sms'").get()).toEqual({ state: "unsubscribed", source: "link" });
    });
});
