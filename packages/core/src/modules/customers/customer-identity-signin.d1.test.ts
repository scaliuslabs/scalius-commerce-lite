// "Continue with <app>": a provider-verified identity signs a buyer in. A known
// subject signs in its customer; a VERIFIED email or phone that proves an
// existing account links to it; an unverified contact never links or creates;
// a new account follows the store's customer accounts policy. The identity
// row, the proof and the session commit together.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createMigratedSqlite, createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ValidationError } from "../../errors";
import { getCustomerBySession, signInWithIdentity } from "./customer-auth.service";

const SESSION_KEY = "test-session-key-0123456789abcdef";
const PROVIDER = "acme.signin:google";
const OTHER_PROVIDER = "acme.signin:apple";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
  sqlite = createMigratedSqlite();
  db = createSqliteD1Database({ sqlite }).db;
});
afterEach(() => sqlite.close());

const setCustomerAccountsPolicy = (document: Record<string, unknown>) =>
  sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('auth', 'document', ?, 'json', 'customer_auth')")
    .run(JSON.stringify(document));

function insertAccount(input: { id: string; email?: string; emailVerified?: boolean; phone?: string; phoneVerified?: boolean; deleted?: boolean }) {
  sqlite.prepare(`INSERT INTO customers (id, name, email, phone, origin, account_claimed_at, email_verified_at, phone_verified_at, deleted_at)
    VALUES (?, 'Karim', ?, ?, 'account', unixepoch(), ?, ?, ?)`)
    .run(
      input.id,
      input.email ?? null,
      input.phone ?? "",
      input.emailVerified ? 1_700_000_000 : null,
      input.phoneVerified ? 1_700_000_000 : null,
      input.deleted ? 1_700_000_000 : null,
    );
}

const signIn = (facts: Parameters<typeof signInWithIdentity>[1]["facts"], providerId = PROVIDER) =>
  signInWithIdentity(db, { providerId, facts, sessionHashKey: SESSION_KEY });

const count = (table: string) => Number((sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
const identities = () => sqlite.prepare("SELECT provider_id, subject, customer_id, last_used_at FROM customer_identities").all() as Array<{
  provider_id: string; subject: string; customer_id: string; last_used_at: number | null;
}>;

describe("known identity", () => {
  it("signs in the customer it was linked to and stamps last_used_at on each sign-in", async () => {
    insertAccount({ id: "cust_1", email: "karim@example.test", emailVerified: true, phone: "+8801711111111", phoneVerified: true });
    const first = await signIn({ subject: "sub-1", email: "karim@example.test", emailVerified: true, phoneVerified: false });
    expect(first).toMatchObject({ status: "signed_in", via: "linked", isNewUser: false });

    sqlite.prepare("UPDATE customer_identities SET last_used_at = 1").run();
    // The provider now sends no verified contact at all: the subject alone is enough.
    const second = await signIn({ subject: "sub-1", emailVerified: false, phoneVerified: false });
    expect(second).toMatchObject({ status: "signed_in", via: "known", isNewUser: false });
    if (second.status !== "signed_in") throw new Error("not signed in");
    expect(second.customer.customerId).toBe("cust_1");
    expect(identities()).toHaveLength(1);
    expect(identities()[0]!.last_used_at).toBeGreaterThan(1);
    expect(count("customers")).toBe(1);
    expect(await getCustomerBySession(db, second.session.token, SESSION_KEY)).toMatchObject({ customerId: "cust_1" });
  });

  it("keeps providers apart: the same subject at another provider is a different identity", async () => {
    insertAccount({ id: "cust_1", email: "karim@example.test", emailVerified: true, phone: "+8801711111111", phoneVerified: true });
    await signIn({ subject: "sub-1", email: "karim@example.test", emailVerified: true, phoneVerified: false });
    await expect(signIn({ subject: "sub-1", emailVerified: false, phoneVerified: false }, OTHER_PROVIDER))
      .resolves.toEqual({ status: "needs_account_details" });
  });

  it("refuses a closed account with the sign-in message", async () => {
    insertAccount({ id: "cust_1", email: "karim@example.test", emailVerified: true, phone: "+8801711111111", phoneVerified: true });
    await signIn({ subject: "sub-1", email: "karim@example.test", emailVerified: true, phoneVerified: false });
    sqlite.prepare("UPDATE customers SET deleted_at = unixepoch() WHERE id = 'cust_1'").run();
    await expect(signIn({ subject: "sub-1", emailVerified: false, phoneVerified: false }))
      .rejects.toThrow(new ValidationError("This account was closed. Contact the store to restore it."));
  });
});

describe("linking by a verified contact", () => {
  it("links a provider-verified email to the account that proved it, in one batch with the session", async () => {
    insertAccount({ id: "cust_1", email: "karim@example.test", emailVerified: true, phone: "+8801711111111" });
    const result = await signIn({ subject: "sub-1", email: "Karim@Example.test", emailVerified: true, phoneVerified: false, name: "Someone Else" });
    expect(result).toMatchObject({ status: "signed_in", via: "linked", isNewUser: false });
    expect(identities()).toEqual([{ provider_id: PROVIDER, subject: "sub-1", customer_id: "cust_1", last_used_at: expect.any(Number) }]);
    expect(count("customer_sessions")).toBe(1);
    expect(count("customers")).toBe(1);
    // The provider never renames the account.
    expect(sqlite.prepare("SELECT name FROM customers WHERE id = 'cust_1'").get()).toEqual({ name: "Karim" });
  });

  it("links a provider-verified phone and counts it as that phone's proof", async () => {
    insertAccount({ id: "cust_1", phone: "+8801711111111", phoneVerified: true });
    insertAccount({ id: "cust_2", email: "other@example.test", emailVerified: true, phone: "+8801722222222" });
    const result = await signIn({ subject: "sub-2", phone: "+8801711111111", phoneVerified: true, emailVerified: false });
    expect(result).toMatchObject({ status: "signed_in", via: "linked" });
    expect(identities()).toEqual([expect.objectContaining({ subject: "sub-2", customer_id: "cust_1" })]);
    expect(sqlite.prepare("SELECT phone_verified_at AS at FROM customers WHERE id = 'cust_1'").get()).toEqual({ at: 1_700_000_000 });
  });

  it("an unverified email never links, never creates", async () => {
    insertAccount({ id: "cust_1", email: "karim@example.test", emailVerified: true, phone: "+8801711111111", phoneVerified: true });
    const result = await signIn({ subject: "sub-9", email: "karim@example.test", emailVerified: false, phone: "+8801711111111", phoneVerified: false, name: "Attacker" });
    expect(result).toEqual({ status: "needs_account_details" });
    expect(identities()).toEqual([]);
    expect(count("customers")).toBe(1);
    expect(count("customer_sessions")).toBe(0);
  });

  it("does not link an account whose email was only typed, never proven", async () => {
    insertAccount({ id: "cust_1", email: "karim@example.test", emailVerified: false, phone: "+8801711111111" });
    setCustomerAccountsPolicy({ email: "optional", whatsapp: "off", channels: ["email"], phoneOptionalForDigital: true });
    const result = await signIn({ subject: "sub-3", email: "karim@example.test", emailVerified: true, phoneVerified: false, name: "Real Owner" });
    expect(result).toMatchObject({ status: "signed_in", via: "created", isNewUser: true });
    expect(count("customers")).toBe(2);
    expect(identities()[0]!.customer_id).not.toBe("cust_1");
  });

  it("refuses a verified contact that belongs to a closed account", async () => {
    insertAccount({ id: "cust_1", email: "karim@example.test", emailVerified: true, phone: "+8801711111111", deleted: true });
    await expect(signIn({ subject: "sub-4", email: "karim@example.test", emailVerified: true, phoneVerified: false, name: "Karim" }))
      .rejects.toThrow("This account was closed");
    expect(identities()).toEqual([]);
  });
});

describe("a new account", () => {
  it("follows the store's policy: a phone is required unless the merchant opted in", async () => {
    const facts = { subject: "sub-5", email: "new@example.test", emailVerified: true, phoneVerified: false, name: "New Buyer" };
    expect(await signIn(facts)).toEqual({ status: "needs_account_details" });
    expect(count("customers")).toBe(0);

    // A verified phone from the provider satisfies the policy and is proven on the account.
    const withPhone = await signIn({ ...facts, phone: "+8801733333333", phoneVerified: true });
    expect(withPhone).toMatchObject({ status: "signed_in", via: "created", isNewUser: true });
    expect(sqlite.prepare("SELECT name, email, phone, origin, email_verified_at IS NOT NULL AS ev, phone_verified_at IS NOT NULL AS pv, account_claimed_at IS NOT NULL AS ac FROM customers").get())
      .toEqual({ name: "New Buyer", email: "new@example.test", phone: "+8801733333333", origin: "account", ev: 1, pv: 1, ac: 1 });
    expect(identities()).toHaveLength(1);
    expect(sqlite.prepare("SELECT change_type FROM customer_history").all()).toEqual([{ change_type: "signed_up" }]);
  });

  it("creates an email-only account when the merchant allows buyers without a phone", async () => {
    setCustomerAccountsPolicy({ email: "optional", whatsapp: "off", channels: ["email"], phoneOptionalForDigital: true });
    const result = await signIn({ subject: "sub-6", email: "new@example.test", emailVerified: true, phoneVerified: false, name: "New Buyer" });
    expect(result).toMatchObject({ status: "signed_in", via: "created", isNewUser: true });
    expect(sqlite.prepare("SELECT phone FROM customers").get()).toEqual({ phone: "" });
    if (result.status === "signed_in") expect(result.customer.phone).toBeUndefined();
  });

  it("asks for details when the provider gave no name or no verified contact", async () => {
    setCustomerAccountsPolicy({ email: "optional", whatsapp: "off", channels: ["email"], phoneOptionalForDigital: true });
    expect(await signIn({ subject: "sub-7", email: "new@example.test", emailVerified: true, phoneVerified: false })).toEqual({ status: "needs_account_details" });
    expect(await signIn({ subject: "sub-8", email: "new@example.test", emailVerified: false, phoneVerified: false, name: "New Buyer" })).toEqual({ status: "needs_account_details" });
    expect(count("customers")).toBe(0);
    expect(identities()).toEqual([]);
  });

  it("requires an email when the merchant requires one", async () => {
    setCustomerAccountsPolicy({ email: "required", whatsapp: "off", channels: ["email"], phoneOptionalForDigital: false });
    const result = await signIn({ subject: "sub-10", phone: "+8801744444444", phoneVerified: true, emailVerified: false, name: "Phone Only" });
    expect(result).toEqual({ status: "needs_account_details" });
  });

  it("refuses a malformed provider id", async () => {
    await expect(signIn({ subject: "sub-11", emailVerified: false, phoneVerified: false }, "google")).rejects.toThrow(ValidationError);
  });
});
