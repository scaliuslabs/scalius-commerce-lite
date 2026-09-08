import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { htmlToPlainText } from "@scalius/shared/html-sanitize";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import type { SendEmailOptions } from "../../integrations/email/provider";
import { sendOrderNotificationEmail } from "./notifications.service";
import type { OrderNotificationType } from "./notification-types";

const transport = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("../../integrations/email", () => ({ sendEmail: transport.sendEmail }));

describe("customer order email composition and delivery", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let reads: string[];
  let failItemRead: boolean;
  let afterOrderRead: (() => void) | undefined;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    const migrations = new URL("../../../../database/migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
      sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
    }
    reads = [];
    failItemRead = false;
    afterOrderRead = undefined;
    const execute = (query: { sql: string; params: unknown[]; method: string }) => {
      if (query.sql.startsWith("select")) reads.push(`${query.sql} ${JSON.stringify(query.params)}`);
      if (failItemRead && query.sql.includes('"order_items"')) throw new Error("Temporary order item read failure");
      const statement = sqlite.prepare(query.sql);
      statement.setReturnArrays(true);
      const result = { rows: query.method === "get"
        ? statement.get(...query.params as SQLInputValue[]) as unknown as unknown[]
        : statement.all(...query.params as SQLInputValue[]) as unknown as unknown[][] };
      if (afterOrderRead && query.sql.includes('from "orders"')) {
        afterOrderRead();
        afterOrderRead = undefined;
      }
      return result;
    };
    db = drizzle(
      async (sql, params, method) => execute({ sql, params, method }),
      async (batch) => batch.map(execute),
      { schema },
    ) as unknown as Database;
    transport.sendEmail.mockReset().mockResolvedValue({ success: true, provider: "mailpit", providerRef: "synthetic-mail", rawStatus: "captured" });
    setting("company_name", "River & Loom", "business_info");
    setting("email", "support@example.test", "business_info");
    setting("phone", "+880 1700-000000", "business_info");
    sqlite.exec(`INSERT INTO products (id, name, price, slug) VALUES ('product', 'Current catalog name', 999, 'email-product');
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone,
        total_amount, shipping_charge, discount_amount, currency_code, currency_decimal_places,
        subtotal_amount_minor, shipping_amount_minor, discount_amount_minor, tax_amount_minor, total_amount_minor,
        tax_label, prices_include_tax, status, payment_method, payment_status, paid_amount, balance_due)
      VALUES ('order_email', 'Email Buyer', '+8801700000000', 'Synthetic address', 'city', 'zone',
        258, 60, 20, 'BDT', 2, 20000, 6000, 2000, 1800, 25800, 'VAT', 0, 'confirmed', 'cod', 'unpaid', 0, 258);
      INSERT INTO order_items (id, order_id, product_id, quantity, price, product_name, variant_label, unit_price_minor, line_subtotal_minor)
      VALUES ('item', 'order_email', 'product', 2, 100, 'Saved cotton shirt', 'Indigo / M', 10000, 20000);
      INSERT INTO order_notification_outbox (id, dedupe_key, order_id, notification_type, source, payload)
      VALUES ('outbox_email', 'email-test', 'order_email', 'order_confirmed', 'test', '{}');`);
  });

  afterEach(() => sqlite.close());

  function setting(key: string, value: string, category = "notifications") {
    sqlite.prepare("INSERT OR REPLACE INTO settings (id, key, value, category, type) VALUES (?, ?, ?, ?, 'text')")
      .run(`${category}:${key}`, key, value, category);
  }

  async function send(type: OrderNotificationType = "order_confirmed", input: {
    email?: string | null;
    orderId?: string;
    name?: string;
    data?: Record<string, unknown>;
    origin?: string;
  } = {}) {
    setting("order_channels", JSON.stringify({ [type]: ["email"] }));
    return sendOrderNotificationEmail(input.email === undefined ? "buyer@example.test" : input.email,
      input.name ?? "Email Buyer", input.orderId ?? "order_email", type, input.data, db,
      { outboxId: "outbox_email", env: { STOREFRONT_URL: input.origin ?? "https://shop.example.test" } });
  }

  function message() {
    expect(transport.sendEmail).toHaveBeenCalledTimes(1);
    const email = transport.sendEmail.mock.calls[0]![0] as SendEmailOptions;
    return { ...email, visible: htmlToPlainText(email.html), links: Array.from(email.html.matchAll(/href="([^"]+)"/g), (match) => match[1]!) };
  }

  it("delivers saved purchase facts, money and working destinations through the real receipt path", async () => {
    const result = await send();
    const email = message();
    // Email clients may discard the outer body and unsupported semantic tags.
    const contentStyle = email.html.match(/<div role="main" style="([^"]+)">/)?.[1];
    for (const style of ["font-family:Arial,Helvetica,sans-serif", "font-size:16px", "line-height:1.5", "color:#202124", "background:#ffffff", "max-width:560px"]) {
      expect(contentStyle).toContain(style);
    }
    for (const text of ["River & Loom", "Saved cotton shirt", "Indigo / M", "2 × BDT 100.00", "BDT 200.00", "BDT 60.00", "BDT 20.00", "VAT", "BDT 18.00", "BDT 258.00", "due on delivery"]) {
      expect(email.visible).toContain(text);
      expect(email.text).toContain(text);
    }
    expect(email.visible).not.toContain("Current catalog name");
    expect(email.visible).not.toContain("999");
    expect(email.links).toContain("https://shop.example.test/account");
    expect(email.links).toContain("https://shop.example.test/");
    expect(email.links.some((link) => link.startsWith("mailto:"))).toBe(true);
    expect(email.links.some((link) => link.startsWith("tel:"))).toBe(true);
    expect(result.hasRetryableFailure).toBe(false);
    expect(sqlite.prepare("SELECT status, attempts FROM order_notification_delivery_receipts").get()).toMatchObject({ status: "accepted", attempts: 1 });
    expect(transport.sendEmail.mock.calls[0]![0].idempotencyKey).toMatch(/^outbox_email:email:/);
    expect(reads.some((query) => query.includes('from "products"'))).toBe(false);
  });

  it("does not read the email projection or resend after an accepted delivery", async () => {
    await send();
    reads.length = 0;
    failItemRead = true;
    await send();
    expect(transport.sendEmail).toHaveBeenCalledTimes(1);
    expect(reads.some((query) => query.includes('"order_items"') || query.includes("business_info"))).toBe(false);
    expect(sqlite.prepare("SELECT attempts FROM order_notification_delivery_receipts").get()).toMatchObject({ attempts: 1 });
  });

  it("keeps item facts and money in the same snapshot when an amendment follows the order read", async () => {
    afterOrderRead = () => sqlite.exec(`UPDATE orders SET subtotal_amount_minor = 100000, total_amount_minor = 105800, total_amount = 1058, balance_due = 1058;
      UPDATE order_items SET product_name = 'Amended shirt', unit_price_minor = 50000, line_subtotal_minor = 100000, price = 500;`);
    await send();
    const email = message();
    expect(email.text).toContain("Saved cotton shirt");
    expect(email.text).toContain("2 × BDT 100.00 — BDT 200.00");
    expect(email.text).toContain("Total: BDT 258.00");
    expect(email.text).not.toContain("Amended shirt");
    expect(sqlite.prepare("SELECT total_amount FROM orders").get()).toMatchObject({ total_amount: 1058 });
  });

  it("keeps a failed projection retryable without accepting a contentless email", async () => {
    failItemRead = true;
    expect((await send()).hasRetryableFailure).toBe(true);
    expect(transport.sendEmail).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT status FROM order_notification_delivery_receipts").get()).toMatchObject({ status: "failed" });
    failItemRead = false;
    sqlite.exec("UPDATE order_notification_delivery_receipts SET next_attempt_at = 0");
    await send();
    expect(message().visible).toContain("Saved cotton shirt");
    expect(sqlite.prepare("SELECT status, attempts FROM order_notification_delivery_receipts").get()).toMatchObject({ status: "accepted", attempts: 2 });
  });

  it.each(["missing recipient", "disabled email"])("avoids item and business reads for %s", async (scenario) => {
    failItemRead = true;
    if (scenario === "missing recipient") await send("order_confirmed", { email: null });
    else {
      setting("order_channels", JSON.stringify({ order_confirmed: [] }));
      await sendOrderNotificationEmail("buyer@example.test", "Buyer", "order_email", "order_confirmed", {}, db);
    }
    expect(transport.sendEmail).not.toHaveBeenCalled();
    expect(reads.some((query) => query.includes('"order_items"') || query.includes("business_info"))).toBe(false);
  });

  it.each([
    ["confirmed", "stripe", "paid", 258, 0, "Paid"],
    ["confirmed", "cod", "partial", 100, 158, "BDT 158.00 due on delivery"],
    ["incomplete", "stripe", "unpaid", 0, 258, "Payment not completed"],
    ["incomplete", "sslcommerz", "failed", 0, 258, "Payment not completed"],
    ["cancelled", "cod", "unpaid", 0, 258, "No payment is due"],
    ["returned", "cod", "partial", 100, 158, "No payment is due"],
    ["refunded", "stripe", "refunded", 0, 0, "Refunded"],
    ["partially_refunded", "stripe", "partial", 100, 158, "Partially refunded"],
  ])("uses saved %s/%s/%s payment meaning", async (status, method, payment, paid, balance, expected) => {
    sqlite.prepare("UPDATE orders SET status = ?, payment_method = ?, payment_status = ?, paid_amount = ?, balance_due = ?").run(status, method, payment, paid, balance);
    await send();
    const email = message();
    expect(email.visible).toContain(expected);
    expect(email.text).toContain(expected);
    if (["cancelled", "returned", "refunded", "partially_refunded"].includes(String(status))) {
      expect(email.visible).not.toContain("due on delivery");
      expect(email.visible).not.toContain("Balance due");
    }
    expect(email.html).not.toContain("payment-recovery");
  });

  it("renders completed refunds without promising a future refund", async () => {
    sqlite.exec("UPDATE orders SET status = 'refunded', payment_status = 'refunded', balance_due = 0");
    await send("order_refunded");
    expect(message().visible).not.toContain("will be processed");
    expect(message().text).not.toContain("will be processed");
  });

  it("marks inclusive tax and uses saved precision instead of current currency defaults", async () => {
    sqlite.exec("UPDATE orders SET currency_code = 'KWD', currency_decimal_places = 3, prices_include_tax = 1, total_amount_minor = 24000, total_amount = 24, shipping_charge = 6, discount_amount = 2, balance_due = 24; UPDATE order_items SET price = 10");
    await send();
    const email = message();
    expect(email.visible).toContain("VAT (included)");
    expect(email.visible).toContain("KWD 24.000");
    expect(email.text).toContain("KWD 20.000");
  });

  it("uses historical decimal money and stored labels when minor snapshots are absent", async () => {
    sqlite.exec("UPDATE orders SET currency_code = 'JPY', currency_decimal_places = 0, subtotal_amount_minor = NULL, shipping_amount_minor = NULL, discount_amount_minor = NULL, total_amount_minor = NULL, tax_amount_minor = 0, total_amount = 240; UPDATE order_items SET unit_price_minor = NULL, line_subtotal_minor = NULL");
    await send();
    expect(message().visible).toContain("2 × JPY 100");
    expect(message().text).toContain("Total: JPY 240");
  });

  it("derives a missing line subtotal from its saved unit price before legacy decimals", async () => {
    sqlite.exec("UPDATE order_items SET line_subtotal_minor = NULL, price = 999");
    await send();
    const email = message();
    expect(email.text).toContain("2 × BDT 100.00 — BDT 200.00");
    expect(email.visible).not.toContain("1,998");
  });

  it.each([[null, null], ["BDT", null], ["INVALID", 2]])("omits money rather than inventing currency for %s/%s", async (code, precision) => {
    sqlite.prepare("UPDATE orders SET currency_code = ?, currency_decimal_places = ?").run(code, precision);
    await send();
    const email = message();
    expect(email.visible).toContain("Saved cotton shirt");
    expect(email.visible).toContain("Quantity: 2");
    expect(email.visible).toContain("Order amounts are unavailable");
    expect(email.text).not.toMatch(/BDT|INVALID|258|NaN/);
  });

  it("escapes item, business, customer, order and event data without corrupting plain text", async () => {
    const unsafe = '<img src=x onerror="alert(1)"> & "test"';
    const id = '<script>alert(1)</script>';
    // IDs are normally generated internally. No-DB legacy dispatch still escapes its input boundary.
    await sendOrderNotificationEmail("buyer@example.test", unsafe, id, "order_shipped", { trackingId: unsafe });
    const email = message();
    expect(email.html).not.toMatch(/<(?:script|img)\b/i);
    expect(email.visible).toContain(id);
    expect(email.text).toContain(unsafe);
  });

  it("escapes persisted labels and permits only intended support/store links", async () => {
    const value = '<img src=x onerror="alert(1)"> & "saved"';
    setting("company_name", value, "business_info");
    setting("email", "support@example.test?subject=unsafe", "business_info");
    setting("phone", "javascript:alert(1)", "business_info");
    sqlite.prepare("UPDATE order_items SET product_name = ?, variant_label = ?").run(value, value);
    await send();
    const email = message();
    expect(email.html).not.toMatch(/<(?:script|img)\b/i);
    expect(email.visible).toContain(value);
    expect(email.text).toContain(value);
    for (const link of email.links) {
      expect(link).toMatch(/^https:\/\/shop\.example\.test\/(?:account)?$/);
    }
  });

  it.each(["", "javascript:alert(1)", "https://user:secret@shop.example.test", "https://shop.example.test/path?buyer=private", "http://public.example.test"])("omits invalid storefront origin %s and absent business facts", async (origin) => {
    sqlite.exec("DELETE FROM settings WHERE category = 'business_info'");
    await send("order_confirmed", { origin });
    const email = message();
    expect(email.links).toEqual([]);
    expect(email.visible).not.toContain("our store");
    expect(email.visible).toContain("Saved cotton shirt");
    expect(email.text).not.toContain("undefined");
  });
});
