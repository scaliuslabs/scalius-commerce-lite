// A signed-in account owner opens their own receipt from any browser: the
// storefront server exchanges the customer session for a private receipt
// proof (the account order page's ownership rule). Everyone else still needs
// the checkout browser's proof.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { hashCustomerSessionToken } from "@scalius/core/modules/customers/customer-auth.service";
import { generateToken } from "../utils/jwt";
import publicBuyerApp from "../runtime/public-buyer-app";

const JWT_SECRET = "owner-receipt-test-secret-0123456789";
const SESSION_KEY = "owner-receipt-session-key-0123456789";
const OWNER_SESSION = "owner-session-token";
const OTHER_SESSION = "other-session-token";

let sqlite: DatabaseSync;
let binding: unknown;

beforeEach(async () => {
  ({ sqlite, binding } = createSqliteD1Database());
  const expires = Math.floor(Date.now() / 1000) + 3_600;
  sqlite.exec(`
    INSERT INTO customers (id, name, email, phone, account_claimed_at, email_verified_at)
      VALUES ('cust_owner', 'Owner', 'owner@example.test', '+8801711000001', unixepoch(), unixepoch()),
             ('cust_other', 'Other', 'other@example.test', '+8801711000002', unixepoch(), unixepoch());
    INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone,
      total_amount_minor, balance_due_minor, customer_id, account_owner_customer_id)
      VALUES ('ORDEROWNED000001', 'Owner', '+8801711000001', 'owner@example.test', 'House 1', 'c', 'z',
        50000, 50000, 'cust_owner', 'cust_owner');
  `);
  for (const [token, customerId] of [[OWNER_SESSION, "cust_owner"], [OTHER_SESSION, "cust_other"]] as const) {
    sqlite.prepare("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?, ?, ?)")
      .run(await hashCustomerSessionToken(token, SESSION_KEY), customerId, expires);
  }
});
afterEach(() => sqlite.close());

const env = () => ({
  DB: binding,
  JWT_SECRET,
  CUSTOMER_SESSION_HASH_KEY: SESSION_KEY,
  CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
}) as unknown as Env;
const service = () => `Bearer ${generateToken({ id: "storefront", role: "service" }, "5m", { JWT_SECRET })}`;

const ownerProof = (headers: Record<string, string>) => publicBuyerApp.request(
  "https://api.example.test/api/v1/orders/receipt/ORDEROWNED000001/owner-proof",
  { method: "POST", headers },
  env(),
);
const receipt = (token?: string) => publicBuyerApp.request(
  "https://api.example.test/api/v1/orders/receipt/ORDEROWNED000001",
  { headers: token ? { "X-Receipt-Token": token } : {} },
  env(),
);

describe("account owner receipt access", () => {
  it("lets the signed-in owner open their receipt without the checkout browser's proof", async () => {
    const response = await ownerProof({ Authorization: service(), "X-Customer-Session": OWNER_SESSION });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const { data } = await response.json() as { data: { orderId: string; receiptToken: string } };
    expect(data.orderId).toBe("ORDEROWNED000001");

    const opened = await receipt(data.receiptToken);
    expect(opened.status).toBe(200);
    await expect(opened.json()).resolves.toMatchObject({
      data: { order: { id: "ORDEROWNED000001", accountLinked: true } },
    });
  });

  it("refuses a different signed-in customer, a missing session, and a caller that is not the storefront", async () => {
    expect((await ownerProof({ Authorization: service(), "X-Customer-Session": OTHER_SESSION })).status).toBe(404);
    expect((await ownerProof({ Authorization: service() })).status).toBe(401);
    expect((await ownerProof({ "X-Customer-Session": OWNER_SESSION })).status).toBe(401);
    expect(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM order_receipts").get()?.n)).toBe(0);
  });

  it("names each discount the order used, delivery savings apart, and echoes the order note", async () => {
    sqlite.exec(`
      UPDATE orders SET notes = ' দয়া করে ফোন করুন ', subtotal_amount_minor = 50000, shipping_amount_minor = 8000,
        discount_amount_minor = 18000, currency_code = 'BDT' WHERE id = 'ORDEROWNED000001';
      INSERT INTO products (id, name, slug, price_minor) VALUES ('prod_kettle', 'Kettle', 'kettle', 50000);
      INSERT INTO order_items (id, order_id, product_id, quantity, unit_price_minor, line_subtotal_minor)
        VALUES ('item_1', 'ORDEROWNED000001', 'prod_kettle', 1, 50000, 50000);
      INSERT INTO promotions (id, name, method, status) VALUES ('promo_eid', 'Eid sale', 'code', 'active'), ('promo_ship', 'Free delivery', 'code', 'active');
      INSERT INTO promotion_codes (id, promotion_id, code, normalized_code) VALUES ('pc_eid', 'promo_eid', 'EID10', 'EID10'), ('pc_ship', 'promo_ship', 'SHIPFREE', 'SHIPFREE');
      INSERT INTO promotion_effects (id, promotion_id, kind, target, allocation, config, position) VALUES
        ('eff_eid', 'promo_eid', 'fixed_amount_off', 'line', 'across', '{"amountMinor":10000,"currencyCode":"BDT"}', 0),
        ('eff_ship', 'promo_ship', 'free', 'shipping', 'once', '{}', 0);
      INSERT INTO order_discount_allocations (id, order_id, order_item_id, promotion_id, effect_id, promotion_revision,
        evaluator_version, method, promotion_name, promotion_code, effect_kind, target, currency_code,
        base_amount_minor, discount_amount_minor, quantity) VALUES
        ('alloc_eid', 'ORDEROWNED000001', 'item_1', 'promo_eid', 'eff_eid', 1, 1, 'code', 'Eid sale', 'EID10', 'fixed_amount_off', 'line', 'BDT', 50000, 10000, 1),
        ('alloc_ship', 'ORDEROWNED000001', NULL, 'promo_ship', 'eff_ship', 1, 1, 'code', 'Free delivery', 'SHIPFREE', 'free', 'shipping', 'BDT', 8000, 8000, NULL);
    `);
    const proof = await ownerProof({ Authorization: service(), "X-Customer-Session": OWNER_SESSION });
    const { data } = await proof.json() as { data: { receiptToken: string } };
    const { data: { order } } = await (await receipt(data.receiptToken)).json() as {
      data: { order: { discounts: unknown[]; notes: string | null } };
    };
    expect(order.discounts).toEqual([
      { promotionId: "promo_eid", title: "Eid sale", code: "EID10", kind: "product", amount: 100, shippingAmount: 0 },
      { promotionId: "promo_ship", title: "Free delivery", code: "SHIPFREE", kind: "shipping", amount: 0, shippingAmount: 80 },
    ]);
    expect(order.notes).toBe("দয়া করে ফোন করুন");
  });

  it("keeps guests on the proof rule", async () => {
    expect((await receipt()).status).toBe(404);
    expect((await receipt("chk_not_a_real_proof")).status).toBe(404);
  });
});
