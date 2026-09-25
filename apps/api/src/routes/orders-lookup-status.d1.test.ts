// Track your order by number alone: a status-only view with no personal data,
// the same 404 for every miss, a strict per-IP limit, and only the storefront
// server may ask (it forwards the buyer's IP).
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { generateToken } from "../utils/jwt";
import publicBuyerApp from "../runtime/public-buyer-app";

const JWT_SECRET = "lookup-status-test-secret-0123456789";

let sqlite: DatabaseSync;
let binding: unknown;
const limiter = { allow: true };
const rateLimiter = { limit: vi.fn(async () => ({ success: limiter.allow })) };

beforeEach(() => {
  limiter.allow = true;
  rateLimiter.limit.mockClear();
  ({ sqlite, binding } = createSqliteD1Database());
  sqlite.exec(`
    INSERT INTO settings (id, key, value, type, category)
      VALUES ('auth', 'document', '{"email":"optional","whatsapp":"separate","channels":["email","sms","whatsapp"]}', 'json', 'customer_auth');
    INSERT INTO orders (id, order_number, customer_name, customer_phone, customer_email, customer_whatsapp, shipping_address, city, zone,
      total_amount_minor, subtotal_amount_minor, shipping_amount_minor, balance_due_minor, shipping_method_name, notes)
      VALUES ('ORDERSTATUS00001', 1057, 'Rahima Khatun Begum', '+8801711000001', 'rahima@example.test', '+8801811000001',
        'House 12, Road 5, Dhanmondi', 'c', 'z', 56000, 50000, 6000, 56000, 'Inside Dhaka', 'Leave it with the guard');
    INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_1', 'Cotton Tee', 'cotton-tee', 25000, 1);
    INSERT INTO order_items (id, order_id, product_id, quantity, product_name, variant_label, unit_price_minor, line_subtotal_minor)
      VALUES ('item_1', 'ORDERSTATUS00001', 'prod_1', 2, 'Cotton Tee', 'Large', 25000, 50000);
  `);
});
afterEach(() => sqlite.close());

const env = () => new Proxy({
  DB: binding,
  JWT_SECRET,
  PUBLIC_API_BASE_URL: "https://api.example.test",
  CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
} as Record<string, unknown>, {
  get(target, key: string) {
    if (key === "RL_STRICT" || key === "RL_STANDARD") return rateLimiter;
    return target[key];
  },
}) as unknown as Env;
const service = () => `Bearer ${generateToken({ id: "storefront", role: "service" }, "5m", { JWT_SECRET })}`;

const lookup = (reference: string, headers: Record<string, string> = { Authorization: service() }) =>
  publicBuyerApp.request("https://api.example.test/api/v1/orders/lookup/status", {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "198.51.100.7", ...headers },
    body: JSON.stringify({ reference }),
  }, env());

describe("track your order by number", () => {
  it("shows where the order is without any personal data", async () => {
    const response = await lookup("#1057");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const { data } = await response.json() as { data: { order: Record<string, unknown> } };
    expect(data.order).toMatchObject({
      orderNumber: 1057,
      firstName: "Rahima",
      shippingMethodName: "Inside Dhaka",
      total: 560,
      items: [{ productName: "Cotton Tee", variantLabel: "Large", quantity: 2, productImage: null }],
      codeOptions: [
        { channel: "email", destination: "r•••@example.test" },
        { channel: "sms", destination: "01•••••001" },
        { channel: "whatsapp", destination: "01•••••001" },
      ],
    });
    const text = JSON.stringify(data);
    for (const secret of ["Khatun", "Begum", "rahima@", "8801711000001", "1711000001", "8801811000001", "House 12", "Dhanmondi", "guard", "ORDERSTATUS00001"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("answers every miss the same way", async () => {
    const missing = await lookup("#9999");
    const byId = await lookup("NOSUCHORDER00001");
    expect(missing.status).toBe(404);
    expect(byId.status).toBe(404);
    expect(await missing.json()).toEqual(await byId.json());
  });

  it("is limited per buyer IP and open only to the storefront server", async () => {
    limiter.allow = false;
    expect((await lookup("#1057")).status).toBe(429);
    expect(rateLimiter.limit).toHaveBeenCalled();
    limiter.allow = true;
    expect((await lookup("#1057", {})).status).toBe(401);
  });
});
