import { describe, expect, it } from "vitest";
import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { customersMessages } from "~/i18n/customers";
import { customerTitle } from "./customer-title";

const translator = (locale: "en" | "bn") => (key: keyof (typeof customersMessages)["en"], vars?: Record<string, string | number>) =>
  customersMessages[locale][key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));
const en = translator("en");
const phone = "+8801712345678";
const shown = formatPhoneForDisplay(phone);

describe("customerTitle", () => {
  it("titles a guest record by its phone, with the latest order's name only as secondary text", () => {
    expect(customerTitle({ kind: "guest", name: "R3-SB Guest One", phone, latestOrderName: "R3-SB Guest Two" }, en))
      .toEqual({ title: `${shown} · guest orders`, detail: "R3-SB Guest Two" });
    expect(customerTitle({ kind: "guest", name: "R3-SB Guest One", phone, latestOrderName: "R3-SB Guest Two" }, translator("bn")).title)
      .toBe(`${shown} · অতিথি অর্ডার`);
  });

  it("never uses the stored name of a guest record, even with no orders left", () => {
    const { title, detail } = customerTitle({ kind: "guest", name: "Someone", phone, latestOrderName: null }, en);
    expect(title).not.toContain("Someone");
    expect(detail).toBeNull();
    expect(customerTitle({ kind: "guest", name: "Someone", phone, latestOrderName: "  " }, en).detail).toBeNull();
  });

  it("keeps the name of an account or a customer the merchant added", () => {
    expect(customerTitle({ kind: "account", name: "Rahim Uddin", phone, latestOrderName: "Karim" }, en))
      .toEqual({ title: "Rahim Uddin", detail: null });
    expect(customerTitle({ kind: "merchant", name: "Nasrin", phone }, en).title).toBe("Nasrin");
    expect(customerTitle({ kind: "merchant", name: " ", phone }, en).title).toBe("No name");
  });
});
