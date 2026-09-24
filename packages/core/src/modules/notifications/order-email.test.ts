import type { DatabaseSync } from "node:sqlite";
import { htmlToPlainText } from "@scalius/shared/html-sanitize";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { SendEmailOptions } from "../../integrations/email/provider";
import { sendOrderNotificationEmail, sendStaffOrderEmails } from "./notifications.service";
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
    reads = [];
    failItemRead = false;
    afterOrderRead = undefined;
    let orderRead = false;
    ({ sqlite, db } = createSqliteD1Database({
      onQuery(query, params) {
        // onQuery runs before execution, so apply the amendment on the statement after the order read.
        if (orderRead && afterOrderRead) {
          afterOrderRead();
          afterOrderRead = undefined;
        }
        orderRead ||= query.includes('from "orders"');
        if (query.startsWith("select")) reads.push(`${query} ${JSON.stringify(params)}`);
        if (failItemRead && query.includes('"order_items"')) throw new Error("Temporary order item read failure");
      },
    }));
    transport.sendEmail.mockReset().mockResolvedValue({ success: true, provider: "mailpit", providerRef: "synthetic-mail", rawStatus: "captured" });
    setting("company_name", "River & Loom", "business_info");
    setting("email", "support@example.test", "business_info");
    setting("phone", "+880 1700-000000", "business_info");
    sqlite.exec(`INSERT INTO products (id, name, price_minor, slug) VALUES ('product', 'Current catalog name', 99900, 'email-product');
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, currency_code, currency_decimal_places,
        subtotal_amount_minor, shipping_amount_minor, discount_amount_minor, tax_amount_minor, total_amount_minor,
        tax_label, prices_include_tax, status, payment_method, payment_status, paid_amount_minor, balance_due_minor)
      VALUES ('order_email', 'Email Buyer', '+8801700000000', 'Synthetic address', 'city', 'zone', 'BDT', 2, 20000, 6000, 2000, 1800, 25800, 'VAT', 0, 'confirmed', 'cod', 'unpaid', 0, 25800);
      INSERT INTO order_items (id, order_id, product_id, quantity, product_name, variant_label, unit_price_minor, line_subtotal_minor)
      VALUES ('item', 'order_email', 'product', 2, 'Saved cotton shirt', 'Indigo / M', 10000, 20000);
      INSERT INTO order_notification_outbox (id, dedupe_key, order_id, notification_type, source, payload)
      VALUES ('outbox_email', 'email-test', 'order_email', 'order_confirmed', 'test', '{}');`);
  });

  afterEach(() => sqlite.close());

  /** Sets one field of a settings document (JSON values are stored as JSON). */
  function setting(key: string, value: string, category = "notifications") {
    const [document, field, isJson] = ({
      "business_info:company_name": ["business", "companyName", false],
      "business_info:email": ["business", "email", false],
      "business_info:phone": ["business", "phone", false],
      "notifications:order_channels": ["notifications", "orderChannels", true],
    } as const)[`${category}:${key}` as "notifications:order_channels"];
    sqlite.prepare("INSERT OR IGNORE INTO settings (id, key, value, category, type) VALUES (?, 'document', '{}', ?, 'json')")
      .run(document, document);
    sqlite.prepare(`UPDATE settings SET value = json_set(value, '$.${field}', ${isJson ? "json(?)" : "?"}) WHERE category = ?`)
      .run(value, document);
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
    for (const text of ["River & Loom", "Saved cotton shirt", "Indigo / M", "2 × ৳100", "৳200", "৳60", "−৳20", "VAT", "৳18", "৳258", "due on delivery"]) {
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
    expect(reads.some((query) => query.includes('"order_items"') || query.includes('"business"'))).toBe(false);
    expect(sqlite.prepare("SELECT attempts FROM order_notification_delivery_receipts").get()).toMatchObject({ attempts: 1 });
  });

  it("keeps item facts and money in the same snapshot when an amendment follows the order read", async () => {
    afterOrderRead = () => sqlite.exec(`UPDATE orders SET subtotal_amount_minor = 100000, total_amount_minor = 105800, balance_due_minor = 105800;
      UPDATE order_items SET product_name = 'Amended shirt', unit_price_minor = 50000, line_subtotal_minor = 100000;`);
    await send();
    const email = message();
    expect(email.text).toContain("Saved cotton shirt");
    expect(email.text).toContain("2 × ৳100 — ৳200");
    expect(email.text).toContain("Total: ৳258");
    expect(email.text).not.toContain("Amended shirt");
    expect(sqlite.prepare("SELECT total_amount_minor FROM orders").get()).toMatchObject({ total_amount_minor: 105800 });
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
    expect(reads.some((query) => query.includes('"order_items"') || query.includes('"business"'))).toBe(false);
  });

  it.each([
    ["confirmed", "stripe", "paid", 258, 0, "Paid"],
    ["confirmed", "cod", "partial", 100, 158, "৳158 due on delivery"],
    ["incomplete", "stripe", "unpaid", 0, 258, "Payment not completed"],
    ["incomplete", "sslcommerz", "failed", 0, 258, "Payment not completed"],
    ["cancelled", "cod", "unpaid", 0, 258, "No payment is due"],
    ["returned", "cod", "partial", 100, 158, "No payment is due"],
    ["refunded", "stripe", "refunded", 0, 0, "Refunded"],
    ["partially_refunded", "stripe", "partial", 100, 158, "Partially refunded"],
  ])("uses saved %s/%s/%s payment meaning", async (status, method, payment, paid, balance, expected) => {
    sqlite.prepare("UPDATE orders SET status = ?, payment_method = ?, payment_status = ?, paid_amount_minor = ?, balance_due_minor = ?")
      .run(status, method, payment, Number(paid) * 100, Number(balance) * 100);
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
    sqlite.exec("UPDATE orders SET status = 'refunded', payment_status = 'refunded', balance_due_minor = 0");
    await send("order_refunded");
    expect(message().visible).not.toContain("will be processed");
    expect(message().text).not.toContain("will be processed");
  });

  it("marks inclusive tax and uses saved precision instead of current currency defaults", async () => {
    sqlite.exec("UPDATE orders SET currency_code = 'KWD', currency_decimal_places = 3, prices_include_tax = 1, total_amount_minor = 24000, shipping_amount_minor = 6000, discount_amount_minor = 2000, balance_due_minor = 24000; UPDATE order_items SET unit_price_minor = 10000");
    await send();
    const email = message();
    expect(email.visible).toContain("VAT (included)");
    expect(email.visible).toContain("KWD 24.000");
    expect(email.text).toContain("KWD 20.000");
  });

  it.each([["INVALID", 2], ["BDT", 7]])("omits money rather than inventing currency for %s/%s", async (code, precision) => {
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
    sqlite.exec("DELETE FROM settings WHERE category = 'business'");
    await send("order_confirmed", { origin });
    const email = message();
    expect(email.links).toEqual([]);
    expect(email.visible).not.toContain("our store");
    expect(email.visible).toContain("Saved cotton shirt");
    expect(email.text).not.toContain("undefined");
  });

  it("renders the merchant's saved template, escaped, with the order number fallback", async () => {
    sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('tpl', 'document', ?, 'json', 'notification_templates')")
      .run(JSON.stringify({
        email: { order_confirmed: { subject: "{{store_name}} confirmed {{order_number}}", body: "Hi {{customer_name}} <b>\n\nPay {{cod_amount}} on delivery." } },
        sms: {},
      }));
    await send("order_confirmed", { name: "Rahim <script>" });
    const email = message();
    expect(email.subject).toBe("River & Loom confirmed #order_email");
    expect(email.html).not.toMatch(/<(?:script|b)\b/i);
    expect(email.visible).toContain("Hi Rahim <script> <b>");
    expect(email.visible).toContain("Pay ৳258 on delivery.");
  });

  it("uses the default copy for events the merchant didn't change", async () => {
    await send("order_confirmed");
    const email = message();
    expect(email.subject).toBe("Order #order_email confirmed");
    expect(email.text).toContain("Hi Email Buyer,\n\nYour order has been confirmed and is being prepared.");
  });

  it("emails each staff recipient once per new order, even when the outbox row is retried", async () => {
    sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('notif', 'document', ?, 'json', 'notifications')")
      .run(JSON.stringify({ staffEmailRecipients: ["owner@shop.test", "buyer@example.test"] }));
    sqlite.exec(`INSERT INTO order_notification_outbox (id, dedupe_key, order_id, notification_type, source, payload)
      VALUES ('outbox_new', 'order_created:order_email', 'order_email', 'order_created', 'test', '{}')`);
    const env = { BETTER_AUTH_URL: "https://admin.shop.test" };
    const order = { id: "order_email", customerName: "Email Buyer", notificationType: "order_created" as const };

    const first = await sendStaffOrderEmails(db, order, { outboxId: "outbox_new", env });
    // A customer email to the same address is a different receipt.
    await sendOrderNotificationEmail("buyer@example.test", "Email Buyer", "order_email", "order_created", undefined, db, { outboxId: "outbox_new", env });
    const retry = await sendStaffOrderEmails(db, order, { outboxId: "outbox_new", env });

    const calls = transport.sendEmail.mock.calls.map((call) => call[0] as SendEmailOptions);
    const staff = calls.filter((call) => call.subject.startsWith("[River & Loom]"));
    expect(staff.map((call) => call.to)).toEqual(["owner@shop.test", "buyer@example.test"]);
    expect(staff[0]!.subject).toBe("[River & Loom] Order #order_email placed by Email Buyer");
    expect(staff[0]!.html).toContain('href="https://admin.shop.test/admin/orders/order_email"');
    expect(staff[0]!.html).not.toContain("/account");
    expect(calls).toHaveLength(3);
    expect(first.outcomes.map((outcome) => outcome.status)).toEqual(["accepted", "accepted"]);
    expect(retry.outcomes.map((outcome) => outcome.status)).toEqual(["accepted", "accepted"]);
    expect(retry.hasRetryableFailure).toBe(false);
    expect(JSON.stringify(first.outcomes)).not.toContain("owner@shop.test");
  });

  it("sends no staff email for other events or when nobody is listed", async () => {
    const other = await sendStaffOrderEmails(db, { id: "order_email", customerName: "B", notificationType: "order_confirmed" }, { outboxId: "outbox_email" });
    const nobody = await sendStaffOrderEmails(db, { id: "order_email", customerName: "B", notificationType: "order_created" }, { outboxId: "outbox_email" });
    expect(other.outcomes).toEqual([]);
    expect(nobody.outcomes).toEqual([]);
    expect(transport.sendEmail).not.toHaveBeenCalled();
  });
});
