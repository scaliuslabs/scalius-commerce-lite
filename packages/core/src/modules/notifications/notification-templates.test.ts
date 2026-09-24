import { describe, expect, it } from "vitest";
import { ORDER_NOTIFICATION_TYPES } from "./notification-types";
import {
  DEFAULT_NOTIFICATION_TEMPLATES,
  findUnknownVariables,
  formatOrderNumber,
  renderTemplate,
  resolveNotificationTemplates,
  sampleOrderEmail,
  variablesForEvent,
} from "./notification-templates";

describe("notification templates", () => {
  it("ships defaults that only use variables their event can fill", () => {
    for (const event of ORDER_NOTIFICATION_TYPES) {
      const email = DEFAULT_NOTIFICATION_TEMPLATES.email[event];
      expect(findUnknownVariables(`${email.subject}\n${email.body}`, event)).toEqual([]);
      expect(findUnknownVariables(DEFAULT_NOTIFICATION_TEMPLATES.sms[event].body, event)).toEqual([]);
    }
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
    const templates = resolveNotificationTemplates({ email: {}, sms: { order_created: { body: "Thanks {{customer_name}}" } } });
    expect(templates.sms.order_created.body).toBe("Thanks {{customer_name}}");
    expect(templates.sms.order_confirmed).toEqual(DEFAULT_NOTIFICATION_TEMPLATES.sms.order_confirmed);
    expect(templates.email.order_created).toEqual(DEFAULT_NOTIFICATION_TEMPLATES.email.order_created);
  });

  it("shows the order number once orders have one, else the short id", () => {
    expect(formatOrderNumber(1001, "K7Q2M9")).toBe("#1001");
    expect(formatOrderNumber(null, "K7Q2M9")).toBe("#K7Q2M9");
    expect(formatOrderNumber(undefined, "K7Q2M9")).toBe("#K7Q2M9");
  });

  it("escapes the merchant's text and the values in the email HTML", () => {
    const email = sampleOrderEmail({
      storeName: "<b>Shop</b>",
      subject: "Order <script>",
      body: "Hi <img src=x onerror=alert(1)>\n\nSecond paragraph & more",
    });
    expect(email.html).not.toMatch(/<(?:script|img|b)\b/i);
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(email.html).toContain("<p style=\"margin:0 0 16px;\">Second paragraph &amp; more</p>");
    expect(email.text).toContain("Hi <img src=x onerror=alert(1)>");
  });
});
