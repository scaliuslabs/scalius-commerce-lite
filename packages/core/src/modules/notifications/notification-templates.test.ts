import { describe, expect, it } from "vitest";
import { ORDER_NOTIFICATION_TYPES } from "./notification-types";
import {
  defaultNotificationTemplates,
  findUnknownVariables,
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

  it("fills variables and leaves out a line whose variable has no value", () => {
    const template = "Hi {{customer_name}}, order {{ order_number }} is on its way!\nTracking: {{tracking_id}}";
    expect(renderTemplate(template, { customer_name: "Rahim", order_number: "#1001", tracking_id: "SF1" }))
      .toBe("Hi Rahim, order #1001 is on its way!\nTracking: SF1");
    expect(renderTemplate(template, { customer_name: "Rahim", order_number: "#1001" }))
      .toBe("Hi Rahim, order #1001 is on its way!");
  });

  it("keeps values on one line and ignores prototype names", () => {
    expect(renderTemplate("Hi {{customer_name}}", { customer_name: "A\nB" })).toBe("Hi A B");
    expect(renderTemplate("x {{__proto__}}\nok", {})).toBe("ok");
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
      language: "en",
      store: { name: "<b>Shop</b>", logoUrl: null },
      subject: "Order <script>",
      body: "Hi <img src=x onerror=alert(1)>\n\nSecond paragraph & more",
    });
    expect(email.html).not.toMatch(/<(?:script|img|b)\b/i);
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(email.html).toContain("<p style=\"margin:0 0 16px;\">Second paragraph &amp; more</p>");
    expect(email.text).toContain("Hi <img src=x onerror=alert(1)>");
  });
});

describe("the sample email the dashboard previews", () => {
  it("uses the real frame: the guest's order link and the frame words in the store's language", () => {
    const email = sampleOrderEmail({
      language: "bn",
      store: { name: "River & Loom", logoUrl: null },
      subject: "অর্ডার #1001 কনফার্ম হয়েছে",
      body: "হ্যালো Rahim,",
      origin: "https://shop.example.test/",
    });
    expect(email.html).toContain('<html lang="bn">');
    expect(email.html).toContain('href="https://shop.example.test/track-order?order=1001"');
    for (const text of ["অর্ডার ট্র্যাক করুন", "অর্ডারের বিবরণ", "ডেলিভারি ঠিকানা", "ক্যাশ অন ডেলিভারি।"]) {
      expect(email.text).toContain(text);
    }
  });
});
