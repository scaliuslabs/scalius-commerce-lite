// Marketing consent on the real migrated schema: the state machine and its
// sources, the e-mail double opt-in through the notification outbox (the
// confirmation mail captured as Mailpit would), signed link security, and the
// newsletter's identity, rate limit and enumeration rules.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { RateLimitError, ValidationError } from "@scalius/core/errors";

import {
    applyConsentChanges,
    confirmMarketingOptIn,
    getCustomerMarketingConsents,
    listCustomerConsentEvents,
    unsubscribeWithLink,
} from "./consent";
import {
    checkoutConsentChanges,
    setCustomerMarketingConsent,
    subscribeToNewsletter,
    updateAccountMarketingPreferences,
} from "./flows";
import {
    deriveOptInToken,
    hashOptInToken,
    marketingUnsubscribeUrl,
    signUnsubscribeToken,
    verifyUnsubscribeToken,
} from "./links";
import { marketingSendPermission, sendMarketingOptInEmail } from "./messages";
import { DEFAULT_MARKETING_CONSENT_SETTINGS } from "@scalius/shared/customer-marketing";

const SECRET = "test-master-secret-that-is-long-enough-123456";
const env = { SCALIUS_SECRET: SECRET, LOCAL_MAILPIT_URL: "http://127.0.0.1:8025" };
const STORE = "https://shop.example.com";

type Row = Record<string, unknown>;

describe("marketing consent", () => {
    let sqlite: DatabaseSync;
    let db: Database;
    const all = (query: string, ...values: Array<string | number | null>) => sqlite.prepare(query).all(...values) as Row[];
    const one = (query: string, ...values: Array<string | number | null>) => sqlite.prepare(query).get(...values) as Row | undefined;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO customers (id, name, phone, email, origin) VALUES ('cust_guest', 'Rahim', '+8801711111111', NULL, 'order');
            INSERT INTO customers (id, name, phone, email, origin, account_claimed_at, phone_verified_at, email_verified_at)
              VALUES ('cust_acct', 'Karim', '+8801722222222', 'karim@example.com', 'account', 1, 1, 1);
            INSERT INTO customers (id, name, phone, email, origin) VALUES ('cust_mail', 'Mina', '+8801733333333', 'Mina@Example.com', 'merchant');
        `);
    });
    afterEach(() => {
        sqlite.close();
        vi.unstubAllGlobals();
    });

    const subscribe = (customerId: string, channel: "email" | "sms" | "whatsapp", extra: Row = {}) => applyConsentChanges(db, {
        customerId,
        env,
        changes: [{ channel, action: "subscribe", source: "newsletter", actor: "buyer", ...extra } as never],
    });

    it("moves through subscribe, no-op repeat, unsubscribe and resubscribe with one audit row and event per change", async () => {
        expect(await subscribe("cust_guest", "sms", { contact: "+8801711111111" })).toEqual([{ channel: "sms", changed: true, confirmationRequested: false }]);
        expect(await subscribe("cust_guest", "sms", { contact: "+8801711111111" })).toEqual([{ channel: "sms", changed: false, confirmationRequested: false }]);
        await applyConsentChanges(db, { customerId: "cust_guest", env, changes: [{ channel: "sms", action: "unsubscribe", source: "account", actor: "buyer" }] });
        await applyConsentChanges(db, { customerId: "cust_guest", env, changes: [{ channel: "sms", action: "unsubscribe", source: "account", actor: "buyer" }] });
        await subscribe("cust_guest", "sms", { contact: "+8801711111111", source: "checkout" });
        const events = await listCustomerConsentEvents(db, "cust_guest");
        expect(events.map((event) => [event.previousState, event.state, event.source]).reverse()).toEqual([
            [null, "subscribed", "newsletter"],
            ["subscribed", "unsubscribed", "account"],
            ["unsubscribed", "subscribed", "checkout"],
        ]);
        expect(all("SELECT topic FROM event_outbox WHERE topic = 'customer.consent_changed'")).toHaveLength(3);
        expect((await getCustomerMarketingConsents(db, "cust_guest")).find((view) => view.channel === "sms")?.status).toBe("subscribed");
    });

    it("never subscribes an address the customer record does not have", async () => {
        expect(await subscribe("cust_guest", "sms", { contact: "+8801799999999" })).toEqual([{ channel: "sms", changed: false, confirmationRequested: false }]);
        expect(await subscribe("cust_acct", "email", { contact: "someone-else@example.com" })).toEqual([{ channel: "email", changed: false, confirmationRequested: false }]);
        // A guest record without e-mail may take it, but an account never.
        expect(await subscribe("cust_guest", "email", { contact: "rahim@example.com", allowBlankGuestEmail: true })).toEqual([{ channel: "email", changed: true, confirmationRequested: false }]);
        expect(one("SELECT email FROM customers WHERE id = 'cust_guest'")).toEqual({ email: "rahim@example.com" });
        expect(one("SELECT change_type, actor, email FROM customer_history WHERE customer_id = 'cust_guest'")).toEqual({ change_type: "updated", actor: "buyer", email: "rahim@example.com" });
        expect(all("SELECT * FROM customer_marketing_consents WHERE customer_id = 'cust_acct'")).toEqual([]);
        // Consent covers an address: a changed e-mail reads not subscribed until asked again.
        await subscribe("cust_mail", "email", { contact: "mina@example.com" });
        sqlite.exec("UPDATE customers SET email = 'new@example.com' WHERE id = 'cust_mail'");
        expect((await getCustomerMarketingConsents(db, "cust_mail")).find((view) => view.channel === "email")).toMatchObject({ status: "not_subscribed", state: "subscribed" });
    });

    it("double opt-in: pending with one outbox row, no resend flood, newer request voids the old link, single-use and expiring confirmation", async () => {
        const start = 1_800_000_000;
        const request = (at: number) => applyConsentChanges(db, {
            customerId: "cust_mail",
            env,
            at,
            changes: [{ channel: "email", action: "subscribe", source: "newsletter", actor: "buyer", contact: "mina@example.com", doubleOptIn: true }],
        });
        expect(await request(start)).toEqual([{ channel: "email", changed: true, confirmationRequested: true }]);
        const first = all("SELECT id, payload, subject_type, notification_type FROM notification_outbox");
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ subject_type: "customer", notification_type: "marketing_opt_in" });
        // The outbox carries a nonce only: no address, no token.
        const firstNonce = JSON.parse(String(first[0]!.payload)).data.nonce as string;
        expect(String(first[0]!.payload)).not.toContain("mina");
        expect(await request(start + 60)).toEqual([{ channel: "email", changed: false, confirmationRequested: false }]);
        expect(all("SELECT id FROM notification_outbox")).toHaveLength(1);
        expect(await request(start + 11 * 60)).toEqual([{ channel: "email", changed: true, confirmationRequested: true }]);
        const outbox = all("SELECT payload FROM notification_outbox ORDER BY created_at, rowid");
        expect(outbox).toHaveLength(2);
        const secondNonce = JSON.parse(String(outbox[1]!.payload)).data.nonce as string;
        const oldToken = await deriveOptInToken(env, { customerId: "cust_mail", nonce: firstNonce });
        const token = await deriveOptInToken(env, { customerId: "cust_mail", nonce: secondNonce });
        expect(one("SELECT state, confirmation_hash FROM customer_marketing_consents")).toEqual({ state: "pending", confirmation_hash: await hashOptInToken(token) });

        expect(await confirmMarketingOptIn(db, oldToken, start + 12 * 60)).toEqual({ status: "invalid" });
        expect(await confirmMarketingOptIn(db, "x".repeat(43), start + 12 * 60)).toEqual({ status: "invalid" });
        expect(await confirmMarketingOptIn(db, token, start + 8 * 24 * 60 * 60)).toEqual({ status: "invalid" });
        expect(await confirmMarketingOptIn(db, token, start + 12 * 60)).toEqual({ status: "confirmed", channel: "email" });
        expect(await confirmMarketingOptIn(db, token, start + 13 * 60)).toEqual({ status: "invalid" });
        expect(one("SELECT state, source, confirmation_hash FROM customer_marketing_consents")).toEqual({ state: "subscribed", source: "newsletter", confirmation_hash: null });
        // Subscribed stays subscribed: a new request sends nothing.
        expect(await request(start + 20 * 60)).toEqual([{ channel: "email", changed: false, confirmationRequested: false }]);
    });

    it("sends the confirmation e-mail through the outbox with the store link, scrubbing it from receipts", async () => {
        const sent: Array<{ url: string; body: Row }> = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
            sent.push({ url, body: JSON.parse(String(init.body)) });
            return new Response(JSON.stringify({ ID: "mailpit-1" }), { status: 200 });
        }));
        await applyConsentChanges(db, {
            customerId: "cust_guest",
            env,
            changes: [{ channel: "email", action: "subscribe", source: "newsletter", actor: "buyer", contact: "rahim@example.com", doubleOptIn: true, allowBlankGuestEmail: true }],
        });
        // Still a guest without e-mail until the link is used.
        expect(one("SELECT email FROM customers WHERE id = 'cust_guest'")).toEqual({ email: null });
        const outbox = one("SELECT id, payload FROM notification_outbox")!;
        const data = JSON.parse(String(outbox.payload)).data as Row;
        const result = await sendMarketingOptInEmail(db, { outboxId: String(outbox.id), customerId: "cust_guest", data }, { env, storefrontUrl: STORE });
        expect(result.hasRetryableFailure).toBe(false);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.url).toBe("http://127.0.0.1:8025/api/v1/send");
        expect(sent[0]!.body.To).toEqual([{ Email: "rahim@example.com" }]);
        const link = /https:\/\/shop\.example\.com\/newsletter\/confirm\?token=([A-Za-z0-9_-]{43})/.exec(String(sent[0]!.body.Text));
        expect(link).not.toBeNull();
        const receipts = all("SELECT status, raw_response, provider_status, recipient_masked FROM notification_delivery_receipts");
        expect(receipts).toHaveLength(1);
        expect(JSON.stringify(receipts)).not.toContain(link![1]);
        expect(await confirmMarketingOptIn(db, link![1]!)).toEqual({ status: "confirmed", channel: "email" });
        expect(one("SELECT email FROM customers WHERE id = 'cust_guest'")).toEqual({ email: "rahim@example.com" });
        // A second delivery of the same row finds nothing pending.
        const again = await sendMarketingOptInEmail(db, { outboxId: String(outbox.id), customerId: "cust_guest", data }, { env, storefrontUrl: STORE });
        expect(again.hasRetryableFailure).toBe(false);
        expect(sent).toHaveLength(1);
    });

    it("signs unsubscribe links that cannot be forged, retargeted or reused under another secret", async () => {
        const token = await signUnsubscribeToken(env, { customerId: "cust_acct", channel: "sms" });
        expect(token).toMatch(/^u1\.[A-Za-z0-9_-]+\.sms\.[A-Za-z0-9_-]{43}$/);
        expect(await verifyUnsubscribeToken(env, token)).toEqual({ customerId: "cust_acct", channel: "sms" });
        const [prefix, id, , signature] = token.split(".");
        expect(await verifyUnsubscribeToken(env, `${prefix}.${id}.email.${signature}`)).toBeNull();
        expect(await verifyUnsubscribeToken(env, `${prefix}.${btoa("cust_guest").replace(/=+$/, "")}.sms.${signature}`)).toBeNull();
        expect(await verifyUnsubscribeToken(env, `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBeNull();
        expect(await verifyUnsubscribeToken({ SCALIUS_SECRET: `${SECRET}-rotated` }, token)).toBeNull();
        for (const junk of ["", "u1", "u2.x.sms.y", 42, null, "u1.a.b.c.d"]) expect(await verifyUnsubscribeToken(env, junk)).toBeNull();
        expect(marketingUnsubscribeUrl(STORE, token)).toBe(`${STORE}/newsletter/unsubscribe?token=${encodeURIComponent(token)}`);
        expect(marketingUnsubscribeUrl("/relative", token)).toBeNull();

        await subscribe("cust_acct", "sms", { contact: "+8801722222222" });
        await unsubscribeWithLink(db, { customerId: "cust_acct", channel: "sms" });
        await unsubscribeWithLink(db, { customerId: "cust_acct", channel: "sms" });
        const events = await listCustomerConsentEvents(db, "cust_acct");
        expect(events.map((event) => [event.state, event.source, event.actor])).toEqual([["unsubscribed", "link", "buyer"], ["subscribed", "newsletter", "buyer"]]);
    });

    it("lets marketing go only to a current subscription, with list headers and a link", async () => {
        expect((await marketingSendPermission(db, { customerId: "cust_acct", channel: "email" }, { env, storefrontUrl: STORE })).allowed).toBe(false);
        await subscribe("cust_acct", "email", { contact: "karim@example.com", source: "account" });
        const permission = await marketingSendPermission(db, { customerId: "cust_acct", channel: "email" }, { env, storefrontUrl: STORE });
        expect(permission).toMatchObject({ allowed: true, contact: "karim@example.com" });
        expect(permission.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
        expect(permission.headers["List-Unsubscribe"]).toBe(`<${permission.unsubscribeUrl}>`);
        // No store URL: no way to unsubscribe, so no marketing.
        expect((await marketingSendPermission(db, { customerId: "cust_acct", channel: "email" }, { env, storefrontUrl: null })).allowed).toBe(false);
    });

    it("records staff and plugin changes with their author, and needs a note for a staff subscribe", async () => {
        await expect(setCustomerMarketingConsent(db, "cust_acct", { channel: "sms", state: "subscribed" }, { actor: "staff", actorId: "usr_1" }, { env }))
            .rejects.toBeInstanceOf(ValidationError);
        await expect(setCustomerMarketingConsent(db, "cust_guest", { channel: "email", state: "subscribed", note: "Asked" }, { actor: "staff", actorId: "usr_1" }, { env }))
            .rejects.toThrow(/no email/);
        await setCustomerMarketingConsent(db, "cust_acct", { channel: "sms", state: "subscribed", note: "Agreed on the phone, 2 Oct" }, { actor: "staff", actorId: "usr_1" }, { env });
        await setCustomerMarketingConsent(db, "cust_acct", { channel: "sms", state: "unsubscribed" }, { actor: "plugin", actorId: "acme.loyalty" }, { env });
        const events = await listCustomerConsentEvents(db, "cust_acct");
        expect(events.map((event) => [event.state, event.source, event.actor, event.actorId, event.note])).toEqual([
            ["unsubscribed", "plugin", "plugin", "acme.loyalty", null],
            ["subscribed", "admin", "staff", "usr_1", "Agreed on the phone, 2 Oct"],
        ]);
    });

    it("account: a verified e-mail subscribes at once, channels turn off", async () => {
        const result = await updateAccountMarketingPreferences(db, "cust_acct", { email: true, sms: true }, { env });
        expect(result.confirmationRequested).toBe(false);
        expect(result.channels.map((channel) => [channel.channel, channel.status])).toEqual([["email", "subscribed"], ["sms", "subscribed"], ["whatsapp", "not_subscribed"]]);
        const off = await updateAccountMarketingPreferences(db, "cust_acct", { sms: false }, { env });
        expect(off.channels.find((channel) => channel.channel === "sms")?.status).toBe("unsubscribed");
        await expect(updateAccountMarketingPreferences(db, "cust_guest", { sms: true }, { env })).rejects.toThrow(/Account not found/);
    });

    it("checkout subscribes only the configured channels the order has, with double opt-in unless the signed-in e-mail is verified", async () => {
        const settings = { ...DEFAULT_MARKETING_CONSENT_SETTINGS, checkout: { ...DEFAULT_MARKETING_CONSENT_SETTINGS.checkout, channels: ["email", "sms", "whatsapp"] as const } };
        const guest = await checkoutConsentChanges({ settings: settings as never, language: "bn", order: { phone: "+8801711111111", email: "A@B.com", whatsapp: null }, signedInVerifiedEmail: null });
        expect(guest.map((change) => [change.channel, "contact" in change ? change.contact : null, "doubleOptIn" in change ? change.doubleOptIn : null])).toEqual([
            ["email", "a@b.com", true],
            ["sms", "+8801711111111", false],
            ["whatsapp", "+8801711111111", false],
        ]);
        expect("consentText" in guest[0]! ? guest[0].consentText?.text : null).toBe(DEFAULT_MARKETING_CONSENT_SETTINGS.checkout.label.bn);
        const account = await checkoutConsentChanges({ settings: settings as never, language: "en", order: { phone: "+8801722222222", email: "karim@example.com", whatsapp: null }, signedInVerifiedEmail: "karim@example.com" });
        expect(account[0]).toMatchObject({ channel: "email", doubleOptIn: false });
        expect(await checkoutConsentChanges({ settings: { ...settings, checkout: { ...settings.checkout, enabled: false } } as never, language: "en", order: { phone: "+8801711111111", email: null, whatsapp: null }, signedInVerifiedEmail: null })).toEqual([]);
    });

    describe("newsletter", () => {
        const runtime = { env, ip: "203.0.113.7" };

        it("files a new subscriber as a guest record keyed by the phone and answers the same whether or not it existed", async () => {
            const fresh = await subscribeToNewsletter(db, { phone: "01755555555", email: "new@example.com" }, runtime);
            const known = await subscribeToNewsletter(db, { phone: "01722222222", email: "other@example.com" }, runtime);
            expect(fresh).toEqual({ result: "pending" });
            expect(known).toEqual({ result: "pending" });
            const created = one("SELECT id, phone, email, origin, account_claimed_at FROM customers WHERE phone = '+8801755555555'");
            expect(created).toMatchObject({ phone: "+8801755555555", email: "new@example.com", origin: "order", account_claimed_at: null });
            // The account's phone is subscribed to SMS; its e-mail is never replaced or subscribed by a stranger's address.
            expect(one("SELECT email FROM customers WHERE id = 'cust_acct'")).toEqual({ email: "karim@example.com" });
            expect(all("SELECT channel, state FROM customer_marketing_consents WHERE customer_id = 'cust_acct'")).toEqual([{ channel: "sms", state: "subscribed" }]);
            expect(await subscribeToNewsletter(db, { phone: "01766666666" }, runtime)).toEqual({ result: "subscribed" });
            await expect(subscribeToNewsletter(db, { phone: "12" }, runtime)).rejects.toBeInstanceOf(ValidationError);
            await expect(subscribeToNewsletter(db, { phone: "01766666666", email: "not-an-email" }, runtime)).rejects.toBeInstanceOf(ValidationError);
            await expect(subscribeToNewsletter(db, { phone: "01766666666", extra: "x" }, runtime)).rejects.toBeInstanceOf(ValidationError);
        });

        it("limits signups per contact and per address", async () => {
            for (let attempt = 0; attempt < 5; attempt += 1) await subscribeToNewsletter(db, { phone: "01777777777" }, runtime);
            await expect(subscribeToNewsletter(db, { phone: "01777777777" }, runtime)).rejects.toBeInstanceOf(RateLimitError);
            const crowd = { env, ip: "198.51.100.1" };
            for (let index = 0; index < 20; index += 1) {
                await subscribeToNewsletter(db, { phone: `01710${String(index).padStart(6, "0")}` }, crowd);
            }
            await expect(subscribeToNewsletter(db, { phone: "01810000000" }, crowd)).rejects.toBeInstanceOf(RateLimitError);
            // Rate-limit keys are hashed: no phone or address in the table.
            expect(JSON.stringify(all("SELECT key FROM customer_auth_otp_rate_limits"))).not.toMatch(/8801777777777|198\.51/);
        });
    });
});
