// A code limited to a customer segment, on the migrated schema through the
// real preview route: the signed-in member (tagged "qa oct3 vip", as staff
// type it) gets it whether the session arrives as the storefront proxy's
// `X-Customer-Session` header or this origin's cookie; a guest, or a member
// whose session is gone, is asked to sign in.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createCustomerSegment, hashCustomerSessionToken } from "@scalius/core/modules/customers";
import { activatePromotion, createPromotionDraft } from "@scalius/core/modules/promotions";

import { errorResponseFromError } from "../utils/api-response";
import { discountRoutes } from "./discounts";

const SIGN_IN = "This code is for selected customers. Sign in with an eligible account.";
const SESSION = "member-session-token";
// Derived from SCALIUS_SECRET at Worker entry; any value works for the test.
const SESSION_HASH_KEY = "test-customer-session-hash-key";
const ENV = { CUSTOMER_SESSION_HASH_KEY: SESSION_HASH_KEY } as unknown as Env;

let sqlite: DatabaseSync;
let db: Database;

beforeEach(async () => {
  ({ sqlite, db } = createSqliteD1Database());
  const now = Math.floor(Date.now() / 1000);
  sqlite.exec(`
    INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_shawl', 'Shawl', 'shawl', 100000, 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
      VALUES ('var_shawl', 'prod_shawl', 'SHAWL-1', 100000, 5, 1, 1);
    INSERT INTO customers (id, name, phone, origin, account_claimed_at, phone_verified_at)
      VALUES ('cust_vip', 'Vip', '+8801700000001', 'account', ${now - 86_400}, ${now - 86_400});
    INSERT INTO customer_tag_links (customer_id, tag) VALUES ('cust_vip', 'qa oct3 vip');
  `);
  sqlite.prepare("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?, 'cust_vip', ?)")
    .run(await hashCustomerSessionToken(SESSION, SESSION_HASH_KEY), now + 3_600);
  const segment = await createCustomerSegment(db, {
    name: "QA VIP",
    definition: { conditions: [{ field: "tags", op: "has_any", tags: ["qa oct3 vip"] }] },
  }, null);
  const draft = await createPromotionDraft(db, {
    method: "code",
    name: "QA VIP 10%",
    codes: [{ code: "QA-OCT3-VIP" }],
    customerSegmentIds: [segment.id],
    effects: [{ kind: "percentage_off", target: "order", allocation: "once", config: { basisPoints: 1_000 } }],
  });
  await activatePromotion(db, draft.id, draft.revision, now - 3_600);
});
afterEach(() => sqlite.close());

async function preview(headers: Record<string, string> = {}) {
  const app = new OpenAPIHono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/discounts", discountRoutes);
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  const response = await app.request("/discounts/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ codes: ["qa-oct3-vip"], items: [{ id: "prod_shawl", price: 1000, quantity: 1, variantId: "var_shawl" }] }),
  }, ENV);
  expect(response.status).toBe(200);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads the JSON body freely
  return (await response.json() as { data: any }).data;
}

describe("a segment-limited code in the cart preview", () => {
  it("applies for the signed-in member, from the storefront proxy's header or the cookie", async () => {
    for (const headers of [{ "X-Customer-Session": SESSION }, { Cookie: `cs_tok=${SESSION}` }]) {
      const data = await preview(headers);
      expect(data.totalDiscount).toBe(100);
      expect(data.discounts).toEqual([expect.objectContaining({ code: "QA-OCT3-VIP", amount: 100 })]);
      expect(data.rejectedCodes).toEqual([]);
    }
  });

  it("asks a guest, or a member whose session ended, to sign in", async () => {
    expect((await preview()).rejectedCodes).toEqual([expect.objectContaining({ code: "QA-OCT3-VIP", message: SIGN_IN })]);
    sqlite.exec("UPDATE customer_sessions SET revoked_at = unixepoch()");
    expect((await preview({ "X-Customer-Session": SESSION })).rejectedCodes)
      .toEqual([expect.objectContaining({ code: "QA-OCT3-VIP", message: SIGN_IN })]);
  });
});
