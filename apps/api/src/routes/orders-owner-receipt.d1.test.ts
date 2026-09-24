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

  it("keeps guests on the proof rule", async () => {
    expect((await receipt()).status).toBe(404);
    expect((await receipt("chk_not_a_real_proof")).status).toBe(404);
  });
});
