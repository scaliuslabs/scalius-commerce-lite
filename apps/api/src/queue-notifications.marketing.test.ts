// E-mail double opt-in end to end: a newsletter signup writes the pending
// consent and its outbox row, the queue message (outbox id only) is
// processed by the real consumer, the confirmation is captured as Mailpit
// would receive it, the outbox row is marked sent with a scrubbed receipt,
// and the link in the mail confirms the subscription exactly once.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { confirmMarketingOptIn, subscribeToNewsletter } from "@scalius/core/modules/customer-marketing";
import { processNotificationMessage } from "./queue-notifications";

const env = {
    SCALIUS_SECRET: "test-master-secret-that-is-long-enough-123456",
    LOCAL_MAILPIT_URL: "http://127.0.0.1:8025",
    STOREFRONT_URL: "https://shop.example.com",
    PUBLIC_API_BASE_URL: "https://api.shop.example.com",
} as unknown as Env;

describe("marketing double opt-in through the notification outbox", () => {
    let sqlite: DatabaseSync;
    let db: Database;
    const mail: Array<Record<string, unknown>> = [];

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        mail.length = 0;
        vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
            if (url !== "http://127.0.0.1:8025/api/v1/send") throw new Error(`unexpected fetch ${url}`);
            mail.push(JSON.parse(String(init.body)));
            return new Response(JSON.stringify({ ID: `mailpit-${mail.length}` }), { status: 200 });
        }));
    });
    afterEach(() => {
        sqlite.close();
        vi.unstubAllGlobals();
    });

    it("queues, sends once and confirms through the link", async () => {
        const queued: Array<{ type: string; outboxId: string }> = [];
        const result = await subscribeToNewsletter(db, { phone: "01755555555", email: "Mina@Example.com", channels: ["email", "sms"], language: "bn" }, {
            env: env as never,
            queue: { send: async (message) => { queued.push(message); } },
            ip: "203.0.113.5",
        });
        expect(result).toEqual({ result: "pending" });
        expect(queued).toHaveLength(1);
        expect(Object.keys(queued[0]!)).toEqual(["type", "outboxId"]);

        await processNotificationMessage(queued[0]! as never, db as never, env);
        expect(sqlite.prepare("SELECT status FROM notification_outbox").get()).toEqual({ status: "sent" });
        expect(mail).toHaveLength(1);
        expect(mail[0]!.To).toEqual([{ Email: "mina@example.com" }]);
        // The store speaks Bangla here only when its checkout language is Bangla; English by default.
        expect(String(mail[0]!.Subject)).toMatch(/Confirm your subscription|সাবস্ক্রিপশন/);
        const link = /https:\/\/shop\.example\.com\/newsletter\/confirm\?token=([A-Za-z0-9_-]{43})/.exec(String(mail[0]!.Text));
        expect(link).not.toBeNull();
        const receipts = JSON.stringify(sqlite.prepare("SELECT * FROM notification_delivery_receipts").all());
        expect(receipts).not.toContain(link![1]);
        expect(receipts).toContain('"subject_type":"customer"');

        // A replayed queue message sends nothing more.
        await processNotificationMessage(queued[0]! as never, db as never, env);
        expect(mail).toHaveLength(1);

        expect(await confirmMarketingOptIn(db, link![1]!)).toEqual({ status: "confirmed", channel: "email" });
        expect(await confirmMarketingOptIn(db, link![1]!)).toEqual({ status: "invalid" });
        expect(sqlite.prepare("SELECT channel, state FROM customer_marketing_consents ORDER BY channel").all()).toEqual([
            { channel: "email", state: "subscribed" },
            { channel: "sms", state: "subscribed" },
        ]);
    });

    it("sends nothing without a store URL and never dead-letters the row", async () => {
        const queued: Array<{ type: string; outboxId: string }> = [];
        await subscribeToNewsletter(db, { phone: "01755555555", email: "mina@example.com", channels: ["email"] }, {
            env: env as never,
            queue: { send: async (message) => { queued.push(message); } },
            ip: "203.0.113.5",
        });
        await processNotificationMessage(queued[0]! as never, db as never, { ...env, STOREFRONT_URL: "" } as Env);
        expect(mail).toHaveLength(0);
        expect(sqlite.prepare("SELECT status FROM notification_outbox").get()).toEqual({ status: "sent" });
        expect(sqlite.prepare("SELECT status, last_error FROM notification_delivery_receipts").get())
            .toMatchObject({ status: "skipped" });
    });
});
