import { describe, expect, it } from "vitest";
import { ORDER_NOTIFICATION_TYPES } from "./notification-types";
import {
  defaultNotificationTemplates,
  findUnknownVariables,
  renderEmailTemplate,
  renderOrderEmail,
  renderSmsTemplate,
  renderSubject,
  renderTemplate,
  resolveNotificationTemplates,
  sampleOrderEmail,
  variablesForEvent,
} from "./notification-templates";

describe("notification templates", () => {
  it.each(["en", "bn"] as const)("ships %s defaults that only use variables their event can fill", (language) => {
    const defaults = defaultNotificationTemplates(language);
    for (const event of ORDER_NOTIFICATION_TYPES) {
      const email = defaults.email[event];
      expect(findUnknownVariables(`${email.subject}\n${email.body}`, event)).toEqual([]);
      expect(findUnknownVariables(defaults.sms[event].body, event)).toEqual([]);
    }
  });

  it("writes the Bangla defaults in Bangla", () => {
    const bn = defaultNotificationTemplates("bn");
    expect(bn.email.order_created.subject).toBe("আপনার অর্ডার {{order_number}} আমরা পেয়েছি");
    expect(bn.email.order_created.body.startsWith("হ্যালো {{customer_name}},\n\n")).toBe(true);
    expect(bn.sms.order_shipped.body).toContain("\nট্র্যাকিং: {{tracking_id}}");
  });

  it("offers tracking only where the sender knows it", () => {
    expect(variablesForEvent("order_shipped")).toContain("tracking_id");
    expect(variablesForEvent("order_confirmed")).not.toContain("tracking_id");
    expect(findUnknownVariables("{{ tracking_id }} {{foo}} {{foo}}", "order_confirmed")).toEqual(["tracking_id", "foo"]);
  });

  it("fills variables and leaves out a line whose variables are all empty", () => {
    const template = "Hi {{customer_name}}, order {{ order_number }} is on its way!\nTracking: {{tracking_id}}";
    expect(renderTemplate(template, { customer_name: "Rahim", order_number: "#1001", tracking_id: "SF1" }))
      .toBe("Hi Rahim, order #1001 is on its way!\nTracking: SF1");
    expect(renderTemplate(template, { customer_name: "Rahim", order_number: "#1001" }))
      .toBe("Hi Rahim, order #1001 is on its way!");
  });

  it("keeps a line with some values, closing up around the empty one", () => {
    expect(renderTemplate("Hi {{customer_name}}, your order {{order_number}} is confirmed.", { order_number: "#1001" }))
      .toBe("Hi, your order #1001 is confirmed.");
    expect(renderTemplate("Hi {{customer_name}},\n\nThanks from {{store_name}} ({{tracking_id}}).", { store_name: "Nokshi" }))
      .toBe("Thanks from Nokshi.");
  });

  it("keeps values on one line and ignores prototype names", () => {
    expect(renderTemplate("Hi {{customer_name}}", { customer_name: "A\nB" })).toBe("Hi A B");
    expect(renderTemplate("x {{__proto__}}\nok", {})).toBe("ok");
  });

  it("never drops a subject: an empty variable is left out and the text closes up", () => {
    const values = { order_number: "#1001", store_name: "" };
    expect(renderSubject("R2-SET B {{order_number}} {{store_name}}", values)).toBe("R2-SET B #1001");
    expect(renderSubject("{{store_name}}: order {{order_number}} is out", values)).toBe("order #1001 is out");
    expect(renderSubject("Order {{order_number}} [{{store_name}}]", values)).toBe("Order #1001");
    expect(renderSubject("Order {{order_number}} - {{store_name}}", values)).toBe("Order #1001");
    expect(renderSubject("Your order from {{store_name}}", values)).toBe("Your order from");
    expect(renderSubject("Line\none {{order_number}}", values)).toBe("Line one #1001");
  });

  it("falls back to the event's default when a subject or message renders empty", () => {
    const values = { order_number: "#1001", customer_name: "Rahim" };
    expect(renderEmailTemplate("order_shipped", "en", { subject: "{{tracking_id}}", body: "Tracking: {{tracking_id}}" }, values))
      .toEqual({ subject: "Order #1001 is on its way", body: "Hi Rahim,\n\nYour order is on its way." });
    expect(renderEmailTemplate("order_confirmed", "bn", { subject: "{{store_name}}", body: "Thanks" }, values).subject)
      .toBe("অর্ডার #1001 কনফার্ম হয়েছে");
    expect(renderSmsTemplate("order_shipped", "en", "{{tracking_id}}", { order_number: "#1001" }))
      .toBe("Hi, your order #1001 is on its way!");
  });

  it("falls back to the default for every event the merchant didn't change", () => {
    const templates = resolveNotificationTemplates({ email: {}, sms: { order_created: { body: "Thanks {{customer_name}}" } } }, "bn");
    // A changed template is used as typed, whatever the checkout language.
    expect(templates.sms.order_created.body).toBe("Thanks {{customer_name}}");
    expect(templates.sms.order_confirmed).toEqual(defaultNotificationTemplates("bn").sms.order_confirmed);
    expect(templates.email.order_created).toEqual(defaultNotificationTemplates("bn").email.order_created);
  });

  it("escapes the merchant's text and the values in the email HTML", () => {
    const email = sampleOrderEmail({
      event: "order_confirmed",
      language: "en",
      store: { name: "<b>Shop</b>", logoUrl: null },
      template: { subject: "Order <script>", body: "Hi <img src=x onerror=alert(1)>\n\nSecond paragraph & more" },
    });
    expect(email.html).not.toMatch(/<(?:script|img|b)\b/i);
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(email.html).toContain("<p style=\"margin:0 0 16px;\">Second paragraph &amp; more</p>");
    expect(email.text).toContain("Hi <img src=x onerror=alert(1)>");
  });

  it("links only plain http(s) addresses in the message, without letting them break out", () => {
    const email = sampleOrderEmail({
      event: "order_shipped",
      language: "en",
      store: { name: "Shop", logoUrl: null },
      template: { subject: "Shipped", body: "Track: {{tracking_url}}.\nNot this: javascript:alert(1) or https://x.test/\"onmouseover=\"alert(1)" },
    });
    expect(email.html).toContain('<a href="https://steadfast.com.bd/t/SF12345678" style="color:#174ea6;">https://steadfast.com.bd/t/SF12345678</a>.');
    expect(email.html).not.toMatch(/href="javascript:|"onmouseover=/);
  });

  it("offers the courier, tracking link and refund amount only where the sender knows them", () => {
    expect(variablesForEvent("order_shipped")).toEqual(expect.arrayContaining(["courier_name", "tracking_url"]));
    expect(variablesForEvent("order_refunded")).toContain("refund_amount");
    expect(variablesForEvent("order_confirmed")).not.toContain("refund_amount");
    expect(renderTemplate(defaultNotificationTemplates("en").sms.order_shipped.body, { customer_name: "Rahim", order_number: "#1001", tracking_id: "SF1" }))
      .toBe("Hi Rahim, your order #1001 is on its way!\nTracking: SF1");
  });
});

describe("line-item properties in the order email", () => {
  const facts = {
    store: { name: "River & Loom", logoUrl: null },
    items: [{
      name: "Brass keyring",
      variant: "Gold",
      quantity: 1,
      unitPrice: "৳650",
      subtotal: "৳650",
      properties: ["Engraving: <b>Rahim</b> & Co", "Gift wrap: Yes"],
    }],
    amounts: null,
    payment: { state: "paid" as const },
    address: [],
    method: [],
    origin: null,
    orderLink: null,
    support: [],
  };

  it.each(["en", "bn"] as const)("lists each property under its line, HTML-escaped (%s)", (language) => {
    const template = defaultNotificationTemplates(language).email.order_confirmed;
    const email = renderOrderEmail({ language, facts, ...renderEmailTemplate("order_confirmed", language, template, { order_number: "#1001" }) });
    expect(email.html).toContain("Engraving: &lt;b&gt;Rahim&lt;/b&gt; &amp; Co");
    expect(email.html).not.toContain("<b>Rahim</b>");
    expect(email.html).toContain("Gift wrap: Yes");
    expect(email.text).toContain("Brass keyring (Gold)\nEngraving: <b>Rahim</b> & Co\nGift wrap: Yes\n1 × ৳650");
  });

  it("never puts properties in the SMS", () => {
    const sms = renderSmsTemplate("order_confirmed", "en", defaultNotificationTemplates("en").sms.order_confirmed.body, { order_number: "#1001" });
    expect(sms).not.toContain("Engraving");
  });

  it("renders lines without properties as before", () => {
    const email = renderOrderEmail({
      language: "en",
      facts: { ...facts, items: [{ ...facts.items[0]!, properties: undefined }] },
      subject: "S",
      body: "B",
    });
    expect(email.text).toContain("Brass keyring (Gold)\n1 × ৳650");
  });
});

describe("the sample email the dashboard previews", () => {
  it("uses the real frame: the guest's order link, the discount breakdown and the store's language", () => {
    const email = sampleOrderEmail({
      event: "order_confirmed",
      language: "bn",
      store: { name: "River & Loom", logoUrl: null },
      template: defaultNotificationTemplates("bn").email.order_confirmed,
      origin: "https://shop.example.test/",
    });
    expect(email.subject).toBe("অর্ডার #1001 কনফার্ম হয়েছে");
    expect(email.html).toContain('<html lang="bn">');
    expect(email.html).toContain('href="https://shop.example.test/track-order?order=1001"');
    expect(email.html).toContain("<s style=\"color:#5f6368;\">৳60</s> ফ্রি");
    for (const text of ["অর্ডার ট্র্যাক করুন", "অর্ডারের বিবরণ", "ডেলিভারি ঠিকানা", "ক্যাশ অন ডেলিভারি।",
      "ছাড় · Eid sale (EID10): −৳100", "ডেলিভারি চার্জ: ফ্রি (আগে ছিল ৳60)"]) {
      expect(email.text).toContain(text);
    }
  });

  it("shows the heading the real email sends when the store has no name", () => {
    const template = { subject: "R2-SET B {{order_number}} {{store_name}}", body: "Hi" };
    const email = sampleOrderEmail({ event: "order_created", language: "en", store: { name: null, logoUrl: null }, template });
    expect(email.subject).toBe("R2-SET B #1001");
    expect(email.html).toContain(">R2-SET B #1001</h1>");
  });
});
