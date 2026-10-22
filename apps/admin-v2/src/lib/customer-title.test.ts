import { afterEach, describe, expect, it } from "vitest";
import { customersMessages } from "~/i18n/customers";
import { setStoreRegion } from "~/lib/store-time-zone";
import { customerTitle } from "./customer-title";

const translator = (locale: "en" | "bn") => (key: keyof (typeof customersMessages)["en"], vars?: Record<string, string | number>) =>
  customersMessages[locale][key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));
const en = translator("en");
const phone = "+8801712345678";

afterEach(() => setStoreRegion("BD"));

describe("customerTitle", () => {
  it("names a guest by the buyer on the latest order, with the phone under it", () => {
    expect(customerTitle({ kind: "guest", name: "R3-SB Guest One", phone, latestOrderName: "Rahim Uddin" }, en))
      .toEqual({ title: "Rahim Uddin", detail: "01712-345678", detailIsPhone: true });
  });

  it("uses the phone, or the email, as the title only when there is no name", () => {
    expect(customerTitle({ kind: "guest", name: "Someone", phone, latestOrderName: null }, en))
      .toEqual({ title: "01712-345678", detail: "Guest orders", detailIsPhone: false });
    expect(customerTitle({ kind: "guest", name: "Someone", phone, latestOrderName: "  " }, en).title).toBe("01712-345678");
    expect(customerTitle({ kind: "guest", name: "Someone", phone: null, email: "a@example.com", latestOrderName: null }, en))
      .toEqual({ title: "a@example.com", detail: "Guest orders", detailIsPhone: false });
    expect(customerTitle({ kind: "guest", name: "Someone", phone, latestOrderName: null }, translator("bn")).detail).toBe("অতিথি অর্ডার");
  });

  it("titles an erased customer \"Erased customer\" with nothing under it, in each language", () => {
    expect(customerTitle({ kind: "account", name: "[erased]", phone: null, email: null }, en))
      .toEqual({ title: "Erased customer", detail: null, detailIsPhone: false });
    expect(customerTitle({ kind: "guest", name: "[erased]", phone: null, latestOrderName: "[erased]" }, translator("bn")).title)
      .toBe("মুছে ফেলা কাস্টমার");
    // An erased order name is never a guest record's title: its contact is.
    expect(customerTitle({ kind: "guest", name: "Someone", phone, latestOrderName: "[erased]" }, en).title).toBe("01712-345678");
  });

  it("never uses the stored name of a guest record", () => {
    expect(customerTitle({ kind: "guest", name: "Someone", phone, latestOrderName: null }, en).title).not.toContain("Someone");
  });

  it("keeps the name of an account or a customer the merchant added, with the phone or email under it", () => {
    expect(customerTitle({ kind: "account", name: "Rahim Uddin", phone, latestOrderName: "Karim" }, en))
      .toEqual({ title: "Rahim Uddin", detail: "01712-345678", detailIsPhone: true });
    expect(customerTitle({ kind: "merchant", name: "Nasrin", phone: null, email: "n@example.com" }, en).detail).toBe("n@example.com");
    expect(customerTitle({ kind: "merchant", name: " ", phone }, en).title).toBe("No name");
  });

  it("writes the phone in the store country's format", () => {
    setStoreRegion("US");
    expect(customerTitle({ kind: "merchant", name: "Nasrin", phone }, en).detail).toBe("+880 1712 345678");
  });
});
