// Track your order: the number alone shows nothing (audit R2 F5); with the
// last 4 phone digits or the email it opens a status view with no address,
// phone, email or surname. The same 404 for every miss (number or contact), a
// strict per-IP and per-order limit, and only the storefront server may ask
// (it forwards the buyer's IP).
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
} as Record<string, unknown>, {
  get(target, key: string) {
    if (key === "RL_STRICT" || key === "RL_STANDARD") return rateLimiter;
    return target[key];
  },
}) as unknown as Env;
const service = () => `Bearer ${generateToken({ id: "storefront", role: "service" }, "5m", { JWT_SECRET })}`;

const lookup = (
  reference: string,
  headers: Record<string, string> = { Authorization: service() },
  contact: string | null = "0001",
) =>
  publicBuyerApp.request("https://api.example.test/api/v1/orders/lookup/status", {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "198.51.100.7", ...headers },
    body: JSON.stringify(contact === null ? { reference } : { reference, contact }),
  }, env());

describe("track your order by number and contact", () => {
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

  it("shows nothing for the order number alone", async () => {
    const alone = await lookup("#1057", undefined, null);
    expect(alone.status).toBe(400);
    const text = await alone.text();
    for (const secret of ["Rahima", "Cotton Tee", "560", "Inside Dhaka", "r•••"]) expect(text).not.toContain(secret);
  });

  it("opens with the email or the last 4 digits of the phone or WhatsApp number", async () => {
    for (const contact of ["0001", "RAHIMA@example.test", "+880 1711-000001"]) {
      expect((await lookup("#1057", undefined, contact)).status, contact).toBe(200);
    }
  });

  it("answers every miss, a wrong contact included, the same way", async () => {
    const missing = await lookup("#9999");
    const byId = await lookup("NOSUCHORDER00001");
    const wrongContact = await lookup("#1057", undefined, "9999");
    const wrongEmail = await lookup("#1057", undefined, "someone@example.test");
    for (const response of [missing, byId, wrongContact, wrongEmail]) expect(response.status).toBe(404);
    const body = await missing.json();
    expect(await byId.json()).toEqual(body);
    expect(await wrongContact.json()).toEqual(body);
    expect(await wrongEmail.json()).toEqual(body);
  });

  it("is limited per buyer IP and open only to the storefront server", async () => {
    limiter.allow = false;
    expect((await lookup("#1057")).status).toBe(429);
    expect(rateLimiter.limit).toHaveBeenCalled();
    limiter.allow = true;
    expect((await lookup("#1057", {})).status).toBe(401);
  });
});
