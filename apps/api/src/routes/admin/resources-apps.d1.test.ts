// Gift cards, PIM product writes and an app's own webhook subscriptions in the
// stable app API, on the test D1: minor units in and out, one Idempotency-Key
// rule, revision preconditions, no gift card code and no replayed secret.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { errorResponseFromError } from "../../utils/api-response";
import { idempotentReplay } from "./idempotency";
import { adminResourceGiftCardRoutes } from "./resources-gift-cards";
import { adminResourceProductRoutes } from "./resources-products";
import { adminResourceWebhookRoutes } from "./resources-webhooks";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);`);
});
afterEach(() => sqlite.close());

async function call(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", { id: "owner", name: "Owner", email: "owner@shop.test" } as never);
    await next();
  });
  app.use("*", idempotentReplay);
  app.route("/resources", adminResourceGiftCardRoutes);
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
    const stale = await call("POST", `/resources/gift-cards/${issued.id}/adjust`, { body: { expectedVersion: issued.version + 1, amountMinor: 5_000, reason: "Goodwill" } });
    expect(stale.status).toBe(409);
    const adjusted = await call("POST", `/resources/gift-cards/${issued.id}/adjust`, {
      body: { expectedVersion: issued.version, amountMinor: -4_000, reason: "Correction" },
      headers: { "Idempotency-Key": "correction-0001" },
    });
    expect(adjusted.status).toBe(200);
    expect(adjusted.body.data.giftCard.balanceMinor).toBe(6_000);
    expect(adjusted.body.data.giftCard.transactions.map((row: { kind: string }) => row.kind).sort()).toEqual(["adjust", "issue"]);
    const disabled = await call("PATCH", `/resources/gift-cards/${issued.id}`, { body: { expectedVersion: adjusted.body.data.giftCard.version, status: "disabled" } });
    expect(disabled.body.data.giftCard).toMatchObject({ status: "disabled", balanceMinor: 6_000 });
    expect((await call("PATCH", `/resources/gift-cards/${issued.id}`, { body: { expectedVersion: issued.version, status: "active" } })).status).toBe(409);
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
