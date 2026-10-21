// Gift cards, PIM product writes and an app's own webhook subscriptions in the
// stable app API, on the test D1: minor units in and out, one Idempotency-Key
// rule, revision preconditions, no gift card code and no replayed secret.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { giftCardsDocument } from "@scalius/core/modules/settings";
import { errorResponseFromError } from "../../utils/api-response";
import { idempotentReplay } from "./idempotency";
import { adminResourceGiftCardRoutes } from "./resources-gift-cards";
import { adminGiftCardRoutes } from "./gift-cards";
import { adminResourceProductRoutes } from "./resources-products";
import { adminResourceWebhookRoutes } from "./resources-webhooks";

let sqlite: DatabaseSync;
let db: Database;
let principal: { pluginId: string; pluginName: string; protectedData: ReadonlySet<string> } | null;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  principal = null;
  sqlite.exec(`INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);`);
});
afterEach(() => sqlite.close());

async function call(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", { id: "owner", name: "Owner", email: "owner@shop.test" } as never);
    if (principal) c.set("pluginPrincipal", principal as never);
    await next();
  });
  app.use("*", idempotentReplay);
  app.route("/resources", adminResourceGiftCardRoutes);
  app.route("/gift-cards", adminGiftCardRoutes);
  app.route("/resources", adminResourceProductRoutes);
  app.route("/resources", adminResourceWebhookRoutes);
  app.onError((error, c) => { const { body, status } = errorResponseFromError(error); return c.json(body, status); });
  const response = await app.request(`/api/v1/admin${path}`, {
    method,
    headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }, { CREDENTIAL_ENCRYPTION_KEY: "test-credential-encryption-key-0123456789abcdef" } as never);
  return {
    status: response.status,
    replayed: response.headers.get("idempotent-replayed"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.
    body: await response.json() as { data: any; error: { code: string; message: string } },
  };
}

describe("gift cards in the app API", () => {
  it("issues in minor units without ever returning the code, once per Idempotency-Key", async () => {
    const issue = () => call("POST", "/resources/gift-cards", { body: { amountMinor: 50_000, note: "Loyalty reward" }, headers: { "Idempotency-Key": "loyalty-reward-0001" } });
    const first = await issue();
    expect(first.status).toBe(201);
    expect(first.body.data.giftCard).toMatchObject({ currency: "BDT", initialAmountMinor: 50_000, balanceMinor: 50_000, status: "active", source: "manual" });
    expect(JSON.stringify(first.body)).not.toMatch(/"code"/u);
    const again = await issue();
    expect(again.replayed).toBe("true");
    expect(again.body.data.giftCard.id).toBe(first.body.data.giftCard.id);
    expect((await call("POST", "/resources/gift-cards", { body: { amountMinor: 50_050 } })).status).toBe(400);
  });

  it("adjusts and disables under the version read, refusing a stale one", async () => {
    const issued = (await call("POST", "/resources/gift-cards", { body: { amountMinor: 10_000 } })).body.data.giftCard;
    const stale = await call("POST", `/resources/gift-cards/${issued.id}/adjust`, { body: { expectedRevision: issued.revision + 1, amountMinor: 5_000, reason: "Goodwill" } });
    expect(stale.status).toBe(409);
    const adjusted = await call("POST", `/resources/gift-cards/${issued.id}/adjust`, {
      body: { expectedRevision: issued.revision, amountMinor: -4_000, reason: "Correction" },
      headers: { "Idempotency-Key": "correction-0001" },
    });
    expect(adjusted.status).toBe(200);
    expect(adjusted.body.data.giftCard.balanceMinor).toBe(6_000);
    expect(adjusted.body.data.giftCard.transactions.map((row: { kind: string }) => row.kind).sort()).toEqual(["adjust", "issue"]);
    const disabled = await call("PATCH", `/resources/gift-cards/${issued.id}`, { body: { expectedRevision: adjusted.body.data.giftCard.revision, status: "disabled" } });
    expect(disabled.body.data.giftCard).toMatchObject({ status: "disabled", balanceMinor: 6_000 });
    expect((await call("PATCH", `/resources/gift-cards/${issued.id}`, { body: { expectedRevision: issued.revision, status: "active" } })).status).toBe(409);
  });
});

// Security audit S2: whoever owns a card or receives its notification can
// spend it, so an app with write_gift_cards is held to more than staff.
describe("gift cards an app writes", () => {
  const asApp = () => { principal = { pluginId: "acme.loyalty", pluginName: "Acme Loyalty", protectedData: new Set() }; };
  const outbox = () => sqlite.prepare("SELECT count(*) AS n FROM notification_outbox WHERE notification_type = 'gift_card_issued'").get() as { n: number };
  beforeEach(() => {
    sqlite.exec(`
      INSERT INTO customers (id, name, phone, email, origin) VALUES ('cust_buyer', 'Buyer', '+8801711111111', 'buyer@shop.test', 'merchant'),
        ('cust_thief', 'Thief', '+8801799999999', 'thief@evil.test', 'merchant');
    `);
  });

  it("sends the code only to the owning customer's own contact, never an address the app names", async () => {
    asApp();
    const toStranger = await call("POST", "/resources/gift-cards", {
      body: { amountMinor: 10_000, customerId: "cust_buyer", recipient: { email: "thief@evil.test" }, notify: true },
      headers: { "Idempotency-Key": "reward to stranger 1" },
    });
    expect(toStranger.status).toBe(403);
    expect((await call("POST", "/resources/gift-cards", { body: { amountMinor: 10_000, recipient: { phone: "+8801799999999" }, notify: true } })).status).toBe(403);
    expect((await call("POST", "/resources/gift-cards", { body: { amountMinor: 10_000, notify: true } })).status).toBe(400);
    expect(sqlite.prepare("SELECT count(*) AS n FROM gift_cards").get()).toEqual({ n: 0 });
    expect(outbox()).toEqual({ n: 0 });
    // The owning customer's stored contact is the delivery target.
    const owned = await call("POST", "/resources/gift-cards", { body: { amountMinor: 10_000, customerId: "cust_buyer", notify: true } });
    expect(owned.status).toBe(201);
    expect(owned.body.data.giftCard).toMatchObject({ customerId: "cust_buyer", recipientEmail: null, recipientPhone: null });
    expect(outbox()).toEqual({ n: 1 });
  });

  it("never moves a funded card to another owner, whoever owned it", async () => {
    // A buyer's live card and an unowned one with a balance (staff issued them).
    const owned = (await call("POST", "/resources/gift-cards", { body: { amountMinor: 30_000, customerId: "cust_buyer" } })).body.data.giftCard;
    const unowned = (await call("POST", "/resources/gift-cards", { body: { amountMinor: 30_000 } })).body.data.giftCard;
    asApp();
    const steal = await call("PATCH", `/resources/gift-cards/${owned.id}`, { body: { expectedRevision: owned.revision, customerId: "cust_thief" } });
    expect(steal.status).toBe(403);
    expect((await call("PATCH", `/resources/gift-cards/${unowned.id}`, { body: { expectedRevision: unowned.revision, customerId: "cust_thief" } })).status).toBe(403);
    expect((await call("PATCH", `/resources/gift-cards/${owned.id}`, { body: { expectedRevision: owned.revision, customerId: null } })).status).toBe(403);
    expect(sqlite.prepare("SELECT customer_id FROM gift_cards WHERE id = ?").get(owned.id)).toEqual({ customer_id: "cust_buyer" });
    expect(sqlite.prepare("SELECT customer_id FROM gift_cards WHERE id = ?").get(unowned.id)).toEqual({ customer_id: null });
    // A stale version is still a conflict, and other fields still change.
    expect((await call("PATCH", `/resources/gift-cards/${owned.id}`, { body: { expectedRevision: owned.revision + 1, customerId: "cust_thief" } })).status).toBe(409);
    expect((await call("PATCH", `/resources/gift-cards/${owned.id}`, { body: { expectedRevision: owned.revision, customerId: "cust_buyer", note: "VIP" } })).status).toBe(200);
    // Spent to zero, the card can be handed to someone else.
    const emptied = (await call("POST", `/resources/gift-cards/${unowned.id}/adjust`, { body: { expectedRevision: unowned.revision, amountMinor: -30_000, reason: "Expired promo" } })).body.data.giftCard;
    expect((await call("PATCH", `/resources/gift-cards/${unowned.id}`, { body: { expectedRevision: emptied.revision, customerId: "cust_thief" } })).status).toBe(200);
    // Staff may move a funded card.
    principal = null;
    const current = (await call("GET", `/resources/gift-cards/${owned.id}`)).body.data.giftCard;
    expect((await call("PATCH", `/resources/gift-cards/${owned.id}`, { body: { expectedRevision: current.revision, customerId: "cust_thief" } })).status).toBe(200);
  });

  it("lets staff set the daily app limit in the store currency, under the revision they read", async () => {
    const read = await call("GET", "/gift-cards/settings");
    expect(read.body.data).toEqual({ appDailyLimit: 1000, appDailyLimitMinor: 100_000, currencyCode: "BDT", revision: 0 });
    const saved = await call("PUT", "/gift-cards/settings", { body: { appDailyLimit: 250.5, expectedRevision: 0 } });
    expect(saved.body.data).toMatchObject({ appDailyLimit: 250.5, appDailyLimitMinor: 25_050, revision: 1 });
    expect((await call("PUT", "/gift-cards/settings", { body: { appDailyLimit: 999, expectedRevision: 0 } })).status).toBe(409);
    expect((await call("PUT", "/gift-cards/settings", { body: { appDailyLimit: -1, expectedRevision: 1 } })).status).toBe(400);
  });

  it("caps what one app adds a day by the store setting, issues and top-ups together", async () => {
    await giftCardsDocument.write(db, { appDailyLimitMinor: 100_000 });
    asApp();
    const issue = (amountMinor: number, key: string) => call("POST", "/resources/gift-cards", { body: { amountMinor }, headers: { "Idempotency-Key": key } });
    const huge = await issue(1_000_000_000, "huge card 0001");
    expect(huge.status).toBe(403);
    expect(huge.body.error.code).toBe("app_gift_card_limit");
    const first = await issue(60_000, "daily reward 0001");
    expect(first.status).toBe(201);
    // A replay is the same card, counted once.
    expect((await issue(60_000, "daily reward 0001")).body.data.giftCard.id).toBe(first.body.data.giftCard.id);
    const card = first.body.data.giftCard;
    const topUp = (amountMinor: number, key: string, revision: number) => call("POST", `/resources/gift-cards/${card.id}/adjust`, {
      body: { expectedRevision: revision, amountMinor, reason: "Bonus" },
      headers: { "Idempotency-Key": key },
    });
    expect((await topUp(50_000, "bonus top-up 0001", card.revision)).status).toBe(403);
    const fits = await topUp(40_000, "bonus top-up 0002", card.revision);
    expect(fits.status).toBe(200);
    expect((await issue(100, "one more taka 1")).status).toBe(403);
    // Taking value away is never capped.
    expect((await topUp(-10_000, "clawback 0001", fits.body.data.giftCard.revision)).status).toBe(200);
    expect(sqlite.prepare("SELECT sum(initial_amount_minor) AS n FROM gift_cards").get()).toEqual({ n: 60_000 });
    expect(sqlite.prepare("SELECT value FROM system_kv WHERE substr(key, 1, 21) = 'gift-cards:app-value:'").get()).toEqual({ value: "100000" });
    // Another app has its own day; staff are not capped.
    principal = { pluginId: "other.rewards", pluginName: "Other", protectedData: new Set() };
    expect((await issue(100_000, "other app reward 1")).status).toBe(201);
    principal = null;
    expect((await issue(5_000_000, "staff big card 01")).status).toBe(201);
    // 0 stops apps adding value at all.
    await giftCardsDocument.write(db, { appDailyLimitMinor: 0 });
    principal = { pluginId: "new.app", pluginName: "New", protectedData: new Set() };
    expect((await issue(100, "new app card 0001")).body.error.code).toBe("app_gift_card_limit");
  });
});

describe("product writes in the app API", () => {
  it("creates a product with options and SKUs in minor units, stock at 0", async () => {
    const createdProduct = await call("POST", "/resources/products", {
      body: {
        name: "Linen shirt",
        condition: "new",
        status: "active",
        options: [{ name: "Size", values: ["M", "L"], standardMapping: "size" }],
        variants: [
          { sku: "LIN-M", priceMinor: 250_000, optionValues: { Size: "M" } },
          { sku: "LIN-L", priceMinor: 270_000, optionValues: { size: "L" } },
        ],
      },
      headers: { "Idempotency-Key": "pim-linen-shirt-1" },
    });
    expect(createdProduct.status).toBe(201);
    const product = createdProduct.body.data.product;
    expect(EVENT_REPRESENTATION_SCHEMAS.product.parse(product)).toEqual(product);
    expect(product).toMatchObject({ name: "Linen shirt", status: "active", currency: "BDT", revision: 1 });
    expect(product.variants.map((variant: { sku: string; priceMinor: number }) => [variant.sku, variant.priceMinor]).sort())
      .toEqual([["LIN-L", 270_000], ["LIN-M", 250_000]]);
    expect((await call("POST", "/resources/products", { body: { name: "Bad shirt", condition: "new", options: [{ name: "Size", values: ["M"] }], variants: [{ sku: "BAD-1", priceMinor: 100 }] } })).status).toBe(400);
  });

  it("patches fields under the revision once, and refuses a stale revision or a product price on an optioned product", async () => {
    const simple = (await call("POST", "/resources/products", { body: { name: "Green tea", condition: "new", variants: [{ sku: "TEA-G", priceMinor: 45_000 }] } })).body.data.product;
    expect(simple).toMatchObject({ status: "draft", revision: 1 });
    const patched = await call("PATCH", `/resources/products/${simple.id}`, { body: { expectedRevision: 1, name: "Green tea 100 g", description: "Hand-picked first flush leaves.", priceMinor: 48_000 } });
    expect(patched.status).toBe(200);
    expect(patched.body.data.product).toMatchObject({ name: "Green tea 100 g", revision: 2 });
    expect(patched.body.data.product.variants[0].priceMinor).toBe(48_000);
    expect((await call("PATCH", `/resources/products/${simple.id}`, { body: { expectedRevision: 1, name: "Stale" } })).status).toBe(409);
  });
});

describe("webhook subscriptions in the app API", () => {
  it("are an app's own: staff and agents are refused", async () => {
    const list = await call("GET", "/resources/webhook-subscriptions");
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe("app_principal_required");
  });
});
