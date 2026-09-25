import type { DatabaseSync } from "node:sqlite";
import { htmlToPlainText } from "@scalius/shared/html-sanitize";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { SendEmailOptions } from "../../integrations/email/provider";
import { sendOrderNotificationEmail, sendStaffOrderEmails } from "./notifications.service";
import type { OrderNotificationType } from "./notification-types";
import { composeOrderSms, pendingDownloadNames, readOrderMessageContext } from "./order-email";

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
    setDocument("business", { companyName: "River & Loom", email: "support@example.test", phone: "+880 1700-000000" });
    sqlite.exec(`INSERT INTO products (id, name, price_minor, slug) VALUES ('product', 'Current catalog name', 99900, 'email-product');
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, city_name, zone_name, area_name,
        shipping_method_name, shipping_method_description, currency_code, currency_decimal_places,
        subtotal_amount_minor, shipping_amount_minor, discount_amount_minor, tax_amount_minor, total_amount_minor,
        tax_label, prices_include_tax, status, payment_method, payment_status, paid_amount_minor, balance_due_minor)
      VALUES ('order_email', 'Email Buyer', '+8801700000000', 'House 1, Road 2', 'city_1', 'zone_1', 'Dhaka', 'Mirpur', 'Section 10',
        'Inside Dhaka', 'Arrives in 1-2 days', 'BDT', 2, 20000, 6000, 2000, 1800, 25800, 'VAT', 0, 'confirmed', 'cod', 'unpaid', 0, 25800);
      INSERT INTO order_items (id, order_id, product_id, quantity, product_name, variant_label, unit_price_minor, line_subtotal_minor)
      VALUES ('item', 'order_email', 'product', 2, 'Saved cotton shirt', 'Indigo / M', 10000, 20000);
      INSERT INTO notification_outbox (id, dedupe_key, subject_type, subject_id, order_id, audience, notification_type, source, payload)
      VALUES ('outbox_email', 'email-test', 'order', 'order_email', 'order_email', 'customer', 'order_confirmed', 'test', '{}');`);
  });

  afterEach(() => sqlite.close());

  /** Merges fields into one stored settings document. */
  function setDocument(document: string, fields: Record<string, unknown>) {
    sqlite.prepare("INSERT OR IGNORE INTO settings (id, key, value, category, type) VALUES (?, 'document', '{}', ?, 'json')")
      .run(document, document);
    sqlite.prepare("UPDATE settings SET value = json_patch(value, ?) WHERE category = ?").run(JSON.stringify(fields), document);
  }

  function activateLanguage(code: string) {
    sqlite.exec("UPDATE checkout_languages SET is_active = 0");
    sqlite.prepare(`INSERT INTO checkout_languages (id, name, code, is_active, is_default, language_data, field_visibility)
      VALUES (?, ?, ?, 1, 0, '{}', '{}')`).run(`lang_${code}`, code, code);
  }

  async function send(type: OrderNotificationType = "order_confirmed", input: {
    email?: string | null;
    data?: Record<string, unknown>;
    origin?: string;
  } = {}) {
    setDocument("notifications", { orderChannels: { [type]: ["email"] } });
    return sendOrderNotificationEmail(input.email === undefined ? "buyer@example.test" : input.email,
      "Queue name", "order_email", type, input.data, db,
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
    expect(email.html).toContain('<html lang="en">');
    expect(email.subject).toBe("Order #order_email confirmed");
    expect(email.fromName).toBe("River & Loom");
    for (const text of ["River & Loom", "Hi Email Buyer,", "Saved cotton shirt", "Indigo / M", "2 × ৳100", "৳200", "৳60", "−৳20", "VAT", "৳18", "Total", "৳258",
      "Cash on delivery. ৳258 due on delivery.",
      "Delivery address", "01700-000000", "House 1, Road 2", "Section 10, Mirpur, Dhaka",
      "Delivery method", "Inside Dhaka", "Arrives in 1-2 days", "Need help?", "support@example.test"]) {
      expect(email.visible).toContain(text);
      expect(email.text).toContain(text);
    }
    expect(email.visible).not.toContain("Current catalog name");
    expect(email.visible).not.toContain("999");
    expect(email.visible).not.toContain("Queue name");
    expect(email.links).toContain("https://shop.example.test/");
    expect(email.links.some((link) => link.startsWith("mailto:"))).toBe(true);
    expect(email.links.some((link) => link.startsWith("tel:"))).toBe(true);
    expect(result.hasRetryableFailure).toBe(false);
    expect(sqlite.prepare("SELECT status, attempts FROM notification_delivery_receipts").get()).toMatchObject({ status: "accepted", attempts: 1 });
    expect(transport.sendEmail.mock.calls[0]![0].idempotencyKey).toMatch(/^outbox_email:email:/);
    expect(reads.some((query) => query.includes('from "products"'))).toBe(false);
  });

  it("sends guests to the public order page and never to an account they do not have", async () => {
    await send("order_created");
    const email = message();
    expect(email.subject).toBe("We've received your order #order_email");
    expect(email.visible).toContain("Track your order");
    expect(email.links).toContain("https://shop.example.test/track-order?order=order_email");
    for (const link of email.links.filter((href) => href.startsWith("https://"))) {
      expect(link).not.toMatch(/account|8801700000000|buyer%40|buyer@/);
    }
    expect(email.visible).not.toMatch(/account/i);
    expect(email.text).not.toMatch(/account/i);
  });

  it("sends account orders to the order in the buyer's account", async () => {
    sqlite.exec(`INSERT INTO customers (id, name, phone) VALUES ('customer_1', 'Email Buyer', '+8801700000000');
      UPDATE orders SET account_owner_customer_id = 'customer_1'`);
    await send();
    const email = message();
    expect(email.visible).toContain("View your order");
    expect(email.links).toContain("https://shop.example.test/account/orders/order_email");
    expect(email.links.some((link) => link.includes("track-order"))).toBe(false);
  });

  it("writes the whole email in Bangla when the active checkout language is Bangla", async () => {
    activateLanguage("bn-BD");
    await send("order_created");
    const email = message();
    expect(email.html).toContain('<html lang="bn">');
    expect(email.subject).toBe("আপনার অর্ডার #order_email আমরা পেয়েছি");
    for (const text of ["হ্যালো Email Buyer,", "অর্ডারের বিবরণ", "সাবটোটাল", "ডেলিভারি চার্জ", "মোট", "৳258",
      "ক্যাশ অন ডেলিভারি। ডেলিভারির সময় ৳258 দিতে হবে।", "ডেলিভারি ঠিকানা", "ডেলিভারি পদ্ধতি", "অর্ডার ট্র্যাক করুন", "কোনো সাহায্য লাগবে?"]) {
      expect(email.visible).toContain(text);
      expect(email.text).toContain(text);
    }
    expect(email.visible).not.toMatch(/Subtotal|Delivery address|Track your order|Cash on delivery/);
  });

  it("brands the email with an absolute header logo, else the store name, and falls back to the legal name", async () => {
    setDocument("header", { logo: { src: "https://cdn.example.test/media/logo.png/320.webp", alt: "" } });
    await send();
    expect(message().html).toMatch(/<img src="https:\/\/cdn\.example\.test\/media\/logo\.png" alt="River &amp; Loom"/);

    transport.sendEmail.mockClear();
    sqlite.exec("DELETE FROM notification_delivery_receipts");
    setDocument("header", { logo: { src: "/media/logo.png" } });
    setDocument("business", { companyName: "", legalName: "River and Loom Ltd" });
    await send();
    const email = message();
    expect(email.html).not.toContain("<img");
    expect(email.fromName).toBe("River and Loom Ltd");
    expect(email.visible).toContain("River and Loom Ltd");
    expect(email.text?.startsWith("River and Loom Ltd")).toBe(true);
  });

  it("acknowledges a cancellation request by email with the default notification settings", async () => {
    sqlite.exec("DELETE FROM settings WHERE category = 'notifications'");
    await sendOrderNotificationEmail("buyer@example.test", "Queue name", "order_email", "support_request_submitted",
      { supportRequestType: "cancel_pre_shipment", supportRequestTypeLabel: "Cancellation request", supportRequestStatus: "submitted" },
      db, { outboxId: "outbox_email", env: { STOREFRONT_URL: "https://shop.example.test" } });
    const email = message();
    expect(email.subject).toBe("We received your cancellation request for order #order_email");
    expect(email.visible).toContain("The store will review it and let you know.");

    transport.sendEmail.mockClear();
    sqlite.exec("DELETE FROM notification_delivery_receipts");
    activateLanguage("bn");
    await send("support_request_status_updated", { data: { supportRequestType: "return", supportRequestStatus: "under_review" } });
    expect(message().subject).toBe("অর্ডার #order_email-এর রিটার্নের অনুরোধ নিয়ে আপডেট");
    expect(message().visible).toContain("আপনার রিটার্নের অনুরোধ পর্যালোচনায় আছে।");
  });

  it("does not read the email projection or resend after an accepted delivery", async () => {
    await send();
    reads.length = 0;
    failItemRead = true;
    await send();
    expect(transport.sendEmail).toHaveBeenCalledTimes(1);
    expect(reads.some((query) => query.includes('"order_items"') || query.includes('"business"'))).toBe(false);
    expect(sqlite.prepare("SELECT attempts FROM notification_delivery_receipts").get()).toMatchObject({ attempts: 1 });
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
    expect(sqlite.prepare("SELECT status FROM notification_delivery_receipts").get()).toMatchObject({ status: "failed" });
    failItemRead = false;
    sqlite.exec("UPDATE notification_delivery_receipts SET next_attempt_at = 0");
    await send();
    expect(message().visible).toContain("Saved cotton shirt");
    expect(sqlite.prepare("SELECT status, attempts FROM notification_delivery_receipts").get()).toMatchObject({ status: "accepted", attempts: 2 });
  });

  it.each(["missing recipient", "disabled email"])("avoids item and business reads for %s", async (scenario) => {
    failItemRead = true;
    if (scenario === "missing recipient") await send("order_confirmed", { email: null });
    else {
      setDocument("notifications", { orderChannels: { order_confirmed: [] } });
      await sendOrderNotificationEmail("buyer@example.test", "Buyer", "order_email", "order_confirmed", {}, db);
    }
    expect(transport.sendEmail).not.toHaveBeenCalled();
    expect(reads.some((query) => query.includes('"order_items"') || query.includes('"business"'))).toBe(false);
  });

  it.each([
    ["confirmed", "stripe", "paid", 258, 0, "Paid"],
    ["confirmed", "cod", "partial", 100, 158, "Partially paid. ৳158 due on delivery."],
    ["incomplete", "stripe", "unpaid", 0, 258, "Payment not completed"],
    ["incomplete", "sslcommerz", "failed", 0, 258, "Payment not completed"],
    ["cancelled", "cod", "unpaid", 0, 258, "No payment is due"],
    ["returned", "cod", "partial", 100, 158, "No payment is due"],
    ["refunded", "stripe", "refunded", 0, 0, "Refunded. No payment is due."],
    ["delivered", "cod", "partially_refunded", 158, 0, "Partially refunded. No payment is due."],
    ["partially_refunded", "stripe", "partial", 100, 158, "Partially refunded. No payment is due."],
  ])("uses saved %s/%s/%s payment meaning", async (status, method, payment, paid, balance, expected) => {
    sqlite.prepare("UPDATE orders SET status = ?, payment_method = ?, payment_status = ?, paid_amount_minor = ?, balance_due_minor = ?")
      .run(status, method, payment, Number(paid) * 100, Number(balance) * 100);
    await send();
    const email = message();
    expect(email.visible).toContain(expected);
    expect(email.text).toContain(expected);
    if (["cancelled", "returned", "refunded", "partially_refunded"].includes(String(status)) || payment === "partially_refunded") {
      expect(email.visible).not.toContain("due on delivery");
    }
    expect(email.html).not.toContain("payment-recovery");
  });

  it("renders refund updates without promising a future refund or leaking provider details", async () => {
    sqlite.exec("UPDATE orders SET status = 'refunded', payment_status = 'refunded', balance_due_minor = 0");
    await send("order_refunded", { data: { lastError: "raw provider failure" } });
    const email = message();
    expect(email.subject).toBe("Order #order_email refunded");
    expect(email.visible).not.toContain("will be processed");
    expect(email.text).not.toContain("will be processed");
    expect(email.html).not.toContain("raw provider failure");
  });

  it("marks inclusive tax and uses saved precision instead of current currency defaults", async () => {
    sqlite.exec("UPDATE orders SET currency_code = 'KWD', currency_decimal_places = 3, prices_include_tax = 1, total_amount_minor = 24500, shipping_amount_minor = 6000, discount_amount_minor = 2000, balance_due_minor = 24500; UPDATE order_items SET unit_price_minor = 10000");
    await send();
    const email = message();
    expect(email.visible).toContain("VAT (included)");
    expect(email.visible).toContain("KWD 24.500");
    expect(email.text).toContain("KWD 20");
  });

  it.each([["INVALID", 2], ["BDT", 7]])("omits money rather than inventing currency for %s/%s", async (code, precision) => {
    sqlite.prepare("UPDATE orders SET currency_code = ?, currency_decimal_places = ?").run(code, precision);
    await send();
    const email = message();
    expect(email.visible).toContain("Saved cotton shirt");
    expect(email.visible).toContain("Quantity: 2");
    expect(email.visible).toContain("Order amounts are unavailable");
    expect(email.visible).toContain("Payment is due on delivery.");
    expect(email.text).not.toMatch(/BDT|INVALID|৳|258|NaN/);
  });

  it("escapes persisted labels and event data and permits only intended links", async () => {
    const value = '<img src=x onerror="alert(1)"> & "saved"';
    setDocument("business", { companyName: value, email: "support@example.test?subject=unsafe", phone: "javascript:alert(1)" });
    sqlite.prepare("UPDATE order_items SET product_name = ?, variant_label = ?").run(value, value);
    sqlite.prepare("UPDATE orders SET customer_name = ?, shipping_address = ?, shipping_method_name = ?").run(value, value, value);
    await send("order_shipped", { data: { trackingId: value } });
    const email = message();
    expect(email.html).not.toMatch(/<(?:script|img)\b/i);
    expect(email.visible).toContain(value);
    expect(email.text).toContain(`Tracking ID: ${value}`);
    expect(email.fromName).toBe(value);
    for (const link of email.links) {
      expect(link).toMatch(/^https:\/\/shop\.example\.test\/(?:track-order\?order=order_email)?$/);
    }
  });

  it.each(["", "javascript:alert(1)", "https://user:secret@shop.example.test", "https://shop.example.test/path?buyer=private", "http://public.example.test"])("omits invalid storefront origin %s and absent business facts", async (origin) => {
    sqlite.exec("DELETE FROM settings WHERE category = 'business'");
    await send("order_confirmed", { origin });
    const email = message();
    expect(email.links).toEqual([]);
    expect(email.fromName).toBeUndefined();
    expect(email.visible).toContain("Saved cotton shirt");
    expect(email.text).not.toContain("undefined");
    expect(email.text).not.toContain("null");
  });

  function setTemplates(templates: Record<string, unknown>) {
    sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('tpl', 'document', ?, 'json', 'notification_templates')")
      .run(JSON.stringify({ email: {}, sms: {}, ...templates }));
  }

  it("renders the merchant's saved template as typed, escaped, inside the store's email frame", async () => {
    sqlite.prepare("UPDATE orders SET customer_name = ?").run("Rahim <script>");
    setTemplates({ email: { order_confirmed: { subject: "{{store_name}} confirmed {{order_number}}", body: "Hi {{customer_name}} <b>\n\nPay {{cod_amount}} on delivery." } } });
    // A Bangla store still sends a changed template exactly as the merchant typed it.
    activateLanguage("bn");
    await send("order_confirmed");
    const email = message();
    expect(email.subject).toBe("River & Loom confirmed #order_email");
    expect(email.html).not.toMatch(/<(?:script|b)\b/i);
    expect(email.visible).toContain("Hi Rahim <script> <b>");
    expect(email.visible).toContain("Pay ৳258 on delivery.");
    expect(email.visible).toContain("অর্ডারের বিবরণ");
  });

  it("names the order by its number once it has one, in the text and the guest's order link", async () => {
    sqlite.exec("UPDATE orders SET order_number = 1001");
    await send("order_created");
    const email = message();
    expect(email.subject).toBe("We've received your order #1001");
    expect(email.links).toContain("https://shop.example.test/track-order?order=1001");
  });

  it("uses the default copy of the checkout language for events the merchant didn't change", async () => {
    await send("order_confirmed");
    expect(message().text).toContain("Hi Email Buyer,\n\nYour order is confirmed and we're getting it ready.");
  });

  it("sends the saved SMS template with the same variables", async () => {
    setTemplates({ sms: { order_confirmed: { body: "{{store_name}}: {{order_number}} confirmed, pay {{cod_amount}}" } } });
    setDocument("notifications", { orderChannels: { order_confirmed: ["sms"] } });
    const sendSms = vi.fn(async () => ({ success: true, providerRef: "sms_1", rawStatus: "sent" }));
    const sms = await import("../../integrations/sms");
    vi.spyOn(sms, "getSmsProviderReadiness").mockResolvedValue({ status: "ready", issues: [], activeProvider: "test" } as never);
    vi.spyOn(sms, "getActiveSmsProvider").mockResolvedValue({ name: "test", sendSms } as never);
    await sendOrderNotificationEmail(null, "Queue name", "order_email", "order_confirmed", undefined, db, {});
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ message: "River & Loom: #order_email confirmed, pay ৳258" }));
    vi.restoreAllMocks();
  });

  it("emails each staff recipient once per new order, even when the outbox row is retried", async () => {
    setDocument("notifications", { staffEmailRecipients: ["owner@shop.test", "buyer@example.test"] });
    sqlite.exec(`INSERT INTO notification_outbox (id, dedupe_key, subject_type, subject_id, order_id, audience, notification_type, source, payload)
      VALUES ('outbox_new', 'order_created:order_email', 'order', 'order_email', 'order_email', 'customer', 'order_created', 'test', '{}')`);
    const env = { BETTER_AUTH_URL: "https://admin.shop.test", STOREFRONT_URL: "https://shop.example.test" };
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
    expect(staff[0]!.html).not.toMatch(/\/account|track-order|mailto:/);
    expect(calls).toHaveLength(3);
    expect(first.outcomes.map((outcome) => outcome.status)).toEqual(["accepted", "accepted"]);
    expect(retry.outcomes.map((outcome) => outcome.status)).toEqual(["accepted", "accepted"]);
    expect(retry.hasRetryableFailure).toBe(false);
    expect(JSON.stringify(first.outcomes)).not.toContain("owner@shop.test");
  });

  it("writes the staff email in the store's language", async () => {
    setDocument("notifications", { staffEmailRecipients: ["owner@shop.test"] });
    activateLanguage("bn");
    await sendStaffOrderEmails(db, { id: "order_email", customerName: "Email Buyer", notificationType: "order_created" }, {});
    const email = message();
    expect(email.subject).toBe("[River & Loom] Email Buyer অর্ডার #order_email করেছেন");
    expect(email.visible).toContain("Email Buyer অর্ডার #order_email করেছেন, মোট ৳258।");
  });

  it("names a discount by its code alone when the title is the code", async () => {
    sqlite.exec(`INSERT INTO promotions (id, name, method) VALUES ('promo_r3', 'r3-order10', 'code');
      INSERT INTO promotion_effects (id, promotion_id, kind, target, allocation, config, position) VALUES
        ('eff_r3', 'promo_r3', 'percentage_off', 'line', 'across', '{"basisPoints":500}', 0);
      INSERT INTO promotion_codes (id, promotion_id, code, normalized_code) VALUES ('code_r3', 'promo_r3', 'R3-ORDER10', 'R3-ORDER10');
      INSERT INTO order_discount_allocations (id, order_id, order_item_id, promotion_id, effect_id, promotion_revision, evaluator_version,
        method, promotion_name, promotion_code, effect_kind, target, currency_code, base_amount_minor, discount_amount_minor, quantity) VALUES
        ('oda_r3', 'order_email', 'item', 'promo_r3', 'eff_r3', 1, 1, 'code', 'r3-order10', 'R3-ORDER10', 'percentage_off', 'line', 'BDT', 20000, 1000, 2);`);
    await send("order_created");
    const email = message();
    expect(email.text).toContain("Discount · r3-order10: −৳10");
    expect(email.text).not.toContain("(R3-ORDER10)");
  });

  it("lists each discount by name and code and shows free delivery on the delivery line, for buyers and staff", async () => {
    sqlite.exec(`INSERT INTO promotions (id, name, method) VALUES ('promo_code', 'Eid sale', 'code'), ('promo_auto', 'Weekend deal', 'automatic'), ('promo_ship', 'Free delivery', 'code');
      INSERT INTO promotion_effects (id, promotion_id, kind, target, allocation, config, position) VALUES
        ('eff_code', 'promo_code', 'percentage_off', 'line', 'across', '{"basisPoints":500}', 0),
        ('eff_auto', 'promo_auto', 'fixed_amount_off', 'order', 'once', '{"amountMinor":400,"currencyCode":"BDT"}', 0),
        ('eff_ship', 'promo_ship', 'free', 'shipping', 'once', '{}', 0);
      INSERT INTO promotion_codes (id, promotion_id, code, normalized_code) VALUES
        ('code_eid', 'promo_code', 'EID10', 'EID10'), ('code_ship', 'promo_ship', 'SHIPFREE', 'SHIPFREE');
      INSERT INTO order_discount_allocations (id, order_id, order_item_id, promotion_id, effect_id, promotion_revision, evaluator_version,
        method, promotion_name, promotion_code, effect_kind, target, currency_code, base_amount_minor, discount_amount_minor, quantity) VALUES
        ('oda_code', 'order_email', 'item', 'promo_code', 'eff_code', 1, 1, 'code', 'Eid sale', 'EID10', 'percentage_off', 'line', 'BDT', 20000, 1000, 2),
        ('oda_auto', 'order_email', 'item', 'promo_auto', 'eff_auto', 1, 1, 'automatic', 'Weekend deal', NULL, 'fixed_amount_off', 'order', 'BDT', 19000, 400, 2),
        ('oda_ship', 'order_email', NULL, 'promo_ship', 'eff_ship', 1, 1, 'code', 'Free delivery', 'SHIPFREE', 'free', 'shipping', 'BDT', 6000, 6000, NULL);
      UPDATE orders SET discount_amount_minor = 7400, total_amount_minor = 20400, balance_due_minor = 20400;`);
    setDocument("notifications", { staffEmailRecipients: ["owner@shop.test"] });

    await send("order_created");
    await sendStaffOrderEmails(db, { id: "order_email", customerName: "Email Buyer", notificationType: "order_created" }, {});

    const [buyer, staff] = transport.sendEmail.mock.calls.map((call) => call[0] as SendEmailOptions);
    for (const email of [buyer!, staff!]) {
      expect(email.text).toContain("Discount · Eid sale (EID10): −৳10\nDiscount · Weekend deal: −৳4\nDelivery: Free (was ৳60)");
      expect(email.text).toContain("Total: ৳204");
      expect(email.text).not.toMatch(/Free delivery|SHIPFREE|Delivery: ৳60/);
      expect(email.html).toContain('<s style="color:#5f6368;">৳60</s> Free');
    }
  });

  it("shows a waived delivery fee as free with the fee it replaced", async () => {
    sqlite.exec(`UPDATE orders SET shipping_amount_minor = 0, shipping_fee_waived = 1, shipping_method_base_amount_minor = 6000,
      discount_amount_minor = 0, total_amount_minor = 21800, balance_due_minor = 21800`);
    await send();
    const email = message();
    expect(email.text).toContain("Subtotal: ৳200\nDelivery: Free (was ৳60)\nVAT: ৳18\nTotal: ৳218");
    expect(email.text).not.toContain("Discount");
  });

  it("keeps a subject whose store-name variable is empty, and never sends a blank subject", async () => {
    sqlite.exec("DELETE FROM settings WHERE category = 'business'");
    setTemplates({ email: { order_confirmed: { subject: "R2-SET B {{order_number}} {{store_name}}", body: "Thanks {{store_name}}\n\nSee you" } } });
    await send();
    expect(message().subject).toBe("R2-SET B #order_email");
    expect(message().text).toContain("See you");
    expect(message().text).not.toContain("Thanks");

    transport.sendEmail.mockClear();
    sqlite.exec("DELETE FROM notification_delivery_receipts; DELETE FROM settings WHERE category = 'notification_templates'");
    setTemplates({ email: { order_confirmed: { subject: "{{store_name}}", body: "Hi" } } });
    await send();
    expect(message().subject).toBe("Order #order_email confirmed");
  });

  it("names the store by its Store URL host when no business name is set", async () => {
    sqlite.exec("DELETE FROM settings WHERE category = 'business'");
    setDocument("platform", { storefrontUrl: "https://www.storefront.scalius.com" });
    setTemplates({ email: { order_confirmed: { subject: "{{store_name}}: order {{order_number}}", body: "Hi" } } });
    await send();
    const email = message();
    expect(email.fromName).toBe("storefront.scalius.com");
    expect(email.subject).toBe("storefront.scalius.com: order #order_email");
    expect(email.text?.startsWith("storefront.scalius.com")).toBe(true);
  });

  it("logs a message the merchant turned off as not sent, without reading or sending anything", async () => {
    failItemRead = true;
    setDocument("notifications", { orderChannels: { support_request_submitted: [] } });
    const result = await sendOrderNotificationEmail("buyer@example.test", "Buyer", "order_email", "support_request_submitted",
      { supportRequestType: "cancel_pre_shipment" }, db, { outboxId: "outbox_email" });

    expect(transport.sendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ hasRetryableFailure: false, outcomes: [expect.objectContaining({ channel: "email", status: "skipped", providerStatus: "notification_turned_off" })] });
    expect(sqlite.prepare("SELECT channel, status, last_error, recipient_masked FROM notification_delivery_receipts").all())
      .toEqual([{ channel: "email", status: "skipped", last_error: "notification_turned_off", recipient_masked: "b***@example.test" }]);
    expect(reads.some((query) => query.includes('"order_items"') || query.includes('"business"'))).toBe(false);
  });

  it("names the courier and links its tracking page in the shipped email and SMS", async () => {
    sqlite.exec(`INSERT INTO delivery_shipments (id, order_id, provider_type, tracking_id, status)
      VALUES ('ship_1', 'order_email', 'steadfast', 'SF987', 'in_transit')`);
    await send("order_shipped", { data: { trackingId: "SF987" } });
    const email = message();
    expect(email.text).toContain("Courier: Steadfast\nTracking ID: SF987\nTrack your parcel: https://steadfast.com.bd/t/SF987");
    expect(email.links).toContain("https://steadfast.com.bd/t/SF987");
  });

  it("leaves out the courier lines when the parcel has no tracking yet", async () => {
    await send("order_shipped");
    const email = message();
    expect(email.text).toContain("Your order is on its way.");
    expect(email.text).not.toMatch(/Courier:|Tracking ID:|Track your parcel:/);
  });

  it("says how much was refunded, in the order's currency", async () => {
    sqlite.exec("UPDATE orders SET status = 'partially_refunded', payment_status = 'partially_refunded'");
    await send("order_partially_refunded", { data: { amount: 120 } });
    expect(message().text).toContain("A partial refund for this order has been processed.\nRefund: ৳120");
  });

  it("carries each line's frozen buyer inputs in the email facts and never in SMS variables", async () => {
    // The snapshot is immutable: the line is written with its properties.
    sqlite.exec("DELETE FROM order_items");
    sqlite.prepare(`INSERT INTO order_items (id, order_id, product_id, quantity, product_name, unit_price_minor,
      line_subtotal_minor, properties) VALUES ('item', 'order_email', 'product', 2, 'Saved cotton shirt', 10000, 20000, ?)`).run(JSON.stringify([
      { key: "engraving", type: "text", label: "Engraving", value: "<b>Anika</b>", displayValue: "<b>Anika</b>", priceMinor: 20000 },
      { key: "fit", type: "select", label: "Fit", value: "slim", displayValue: "Slim", priceMinor: 0 },
      { broken: true },
    ]));
    const context = await readOrderMessageContext({ orderId: "order_email", type: "order_confirmed" }, db);
    const [item] = context.facts.items as Array<(typeof context.facts.items)[number] & { properties: string[] }>;
    // Plain text: the template escapes it where it renders.
    expect(item?.properties).toEqual(["Engraving: <b>Anika</b> (+৳200)", "Fit: Slim"]);
    expect(JSON.stringify(context.variables)).not.toMatch(/Anika|Engraving/);
    expect(composeOrderSms(context, "{{order_number}} {{order_total}}")).not.toMatch(/Anika|Engraving/);
  });

  it("gives lines without buyer inputs an empty list", async () => {
    const context = await readOrderMessageContext({ orderId: "order_email", type: "order_confirmed" }, db);
    expect((context.facts.items[0] as { properties?: string[] }).properties).toEqual([]);
  });

  it("sends no staff email for other events or when nobody is listed", async () => {
    const other = await sendStaffOrderEmails(db, { id: "order_email", customerName: "B", notificationType: "order_confirmed" }, { outboxId: "outbox_email" });
    const nobody = await sendStaffOrderEmails(db, { id: "order_email", customerName: "B", notificationType: "order_created" }, { outboxId: "outbox_email" });
    expect(other.outcomes).toEqual([]);
    expect(nobody.outcomes).toEqual([]);
    expect(transport.sendEmail).not.toHaveBeenCalled();
  });

  it("says a store-credit refund is store credit on a gift card, with its last 4 only", async () => {
    const credit = await readOrderMessageContext({
      orderId: "order_email",
      type: "order_refunded",
      data: { amount: 258, settlement: "store_credit", storeCreditLast4: "7K2Q" },
    }, db);
    expect(credit.variables.refund_amount).toBe("৳258 as store credit on a gift card ending 7K2Q. Use it at checkout.");
    const cash = await readOrderMessageContext({ orderId: "order_email", type: "order_refunded", data: { amount: 258 } }, db);
    expect(cash.variables.refund_amount).toBe("৳258");
  });
});

describe("the delivered message and downloads still being prepared", () => {
  it("names only the download lines not yet delivered", () => {
    const line = { productName: "Recipe book", fulfillmentType: "digital", quantity: 2, fulfilledQuantity: 1 };
    expect(pendingDownloadNames([
      line,
      { ...line, productName: "Font pack", fulfilledQuantity: 2 },
      { ...line, productName: "Clay mug", fulfillmentType: "ship", fulfilledQuantity: 0 },
      { ...line, productName: "  " },
    ])).toBe("Recipe book");
    expect(pendingDownloadNames([{ ...line, fulfilledQuantity: 2 }])).toBe("");
  });
});
