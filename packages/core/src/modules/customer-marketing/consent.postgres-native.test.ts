// PostgreSQL parity for marketing consent: every change is an insert-select
// upsert (ON CONFLICT on the customer and channel) and the double opt-in adds an
// outbox row with an ON CONFLICT DO NOTHING on its dedupe key. PostgreSQL takes
// a bare column in a conflict target, so the adapter's compiler strips the
// qualifier Drizzle writes. Opt-in: point SCALIUS_TEST_POSTGRES_URL at a
// disposable server; the test creates and drops its own database.
import { afterAll, describe, expect, it } from "vitest";

import { closeNativePostgres, createNativePostgres, nativePostgresUrl } from "@scalius/database/testing/postgres-native";

import { applyConsentChanges, confirmMarketingOptIn, getCustomerMarketingConsents, listCustomerConsentEvents } from "./consent";
import { deriveOptInToken, hashOptInToken } from "./links";

const postgresUrl = nativePostgresUrl();
const env = { SCALIUS_SECRET: "test-master-secret-that-is-long-enough-123456", LOCAL_MAILPIT_URL: "http://127.0.0.1:8025" };

afterAll(closeNativePostgres);

describe.runIf(postgresUrl)("marketing consent on PostgreSQL", () => {
    it("moves through subscribe, no-op repeat, unsubscribe and resubscribe, with one audit event per change", async () => {
        const { db, client } = await createNativePostgres({ label: "consent" });
        await client.query(`INSERT INTO customers (id, name, phone, email, origin) VALUES ('cust_guest', 'Rahim', '+8801711111111', NULL, 'order')`);
        const subscribe = (extra: Record<string, unknown> = {}) => applyConsentChanges(db, {
            customerId: "cust_guest",
            env,
            changes: [{ channel: "sms", action: "subscribe", source: "newsletter", actor: "buyer", contact: "+8801711111111", ...extra } as never],
        });
        const unsubscribe = () => applyConsentChanges(db, {
            customerId: "cust_guest",
            env,
            changes: [{ channel: "sms", action: "unsubscribe", source: "account", actor: "buyer" }],
        });

        expect(await subscribe()).toEqual([{ channel: "sms", changed: true, confirmationRequested: false }]);
        expect(await subscribe()).toEqual([{ channel: "sms", changed: false, confirmationRequested: false }]);
        await unsubscribe();
        await unsubscribe();
        await subscribe({ source: "checkout" });
        const events = await listCustomerConsentEvents(db, "cust_guest");
        expect(events.map((event) => [event.previousState, event.state, event.source]).reverse()).toEqual([
            [null, "subscribed", "newsletter"],
            ["subscribed", "unsubscribed", "account"],
            ["unsubscribed", "subscribed", "checkout"],
        ]);
        expect((await getCustomerMarketingConsents(db, "cust_guest")).find((view) => view.channel === "sms")?.status).toBe("subscribed");
    });

    it("double opt-in: one pending row and outbox row, no resend flood, a newer request voids the old link", async () => {
        const { db, client } = await createNativePostgres({ label: "optin" });
        await client.query(`INSERT INTO customers (id, name, phone, email, origin) VALUES ('cust_mail', 'Mina', '+8801733333333', 'Mina@Example.com', 'merchant')`);
        const start = 1_800_000_000;
        const request = (at: number) => applyConsentChanges(db, {
            customerId: "cust_mail",
            env,
            at,
            changes: [{ channel: "email", action: "subscribe", source: "newsletter", actor: "buyer", contact: "mina@example.com", doubleOptIn: true }],
        });
        const nonces = async () => (await client.query("SELECT payload FROM notification_outbox ORDER BY created_at, id")).rows
            .map((row) => JSON.parse(String(row.payload)).data.nonce as string);

        expect(await request(start)).toEqual([{ channel: "email", changed: true, confirmationRequested: true }]);
        const [firstNonce] = await nonces();
        expect(await request(start + 60)).toEqual([{ channel: "email", changed: false, confirmationRequested: false }]);
        expect(await nonces()).toHaveLength(1);
        expect(await request(start + 11 * 60)).toEqual([{ channel: "email", changed: true, confirmationRequested: true }]);
        const issued = await nonces();
        expect(issued).toHaveLength(2);
        const oldToken = await deriveOptInToken(env, { customerId: "cust_mail", nonce: firstNonce! });
        const token = await deriveOptInToken(env, { customerId: "cust_mail", nonce: issued.find((nonce) => nonce !== firstNonce)! });
        expect((await client.query("SELECT state, confirmation_hash FROM customer_marketing_consents")).rows)
            .toEqual([{ state: "pending", confirmation_hash: await hashOptInToken(token) }]);

        expect(await confirmMarketingOptIn(db, oldToken, start + 12 * 60)).toEqual({ status: "invalid" });
        expect(await confirmMarketingOptIn(db, token, start + 12 * 60)).toEqual({ status: "confirmed", channel: "email" });
        expect(await confirmMarketingOptIn(db, token, start + 13 * 60)).toEqual({ status: "invalid" });
        expect((await client.query("SELECT state, confirmation_hash FROM customer_marketing_consents")).rows)
            .toEqual([{ state: "subscribed", confirmation_hash: null }]);
    });
});
