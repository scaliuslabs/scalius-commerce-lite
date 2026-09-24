import { describe, expect, it } from "vitest";
import { composeAuthOtpMessage, storeDisplayName } from "./store-messages";

describe("the store's display name", () => {
  it("uses the business name, then the legal name, then the Store URL host, never a blank", () => {
    expect(storeDisplayName({ companyName: " Nokshi ", legalName: "Nokshi Ltd" }, "https://shop.test")).toBe("Nokshi");
    expect(storeDisplayName({ companyName: "", legalName: "Nokshi Ltd" }, "https://shop.test")).toBe("Nokshi Ltd");
    expect(storeDisplayName({ companyName: "", legalName: "" }, "https://www.storefront.scalius.com")).toBe("storefront.scalius.com");
    expect(storeDisplayName({ companyName: "", legalName: "" }, "http://localhost:4322")).toBe("localhost:4322");
    expect(storeDisplayName({ companyName: "", legalName: "" }, "")).toBeNull();
    expect(storeDisplayName({ companyName: "", legalName: "" }, "javascript:alert(1)")).toBeNull();
  });
});

describe("one-time code messages", () => {
  const store = { name: "River & Loom", logoUrl: null, language: "en" as const };

  it("keeps each SMS to one segment: 160 GSM characters in English, 70 Unicode characters in Bangla", () => {
    const en = composeAuthOtpMessage(store, { purpose: "customer_login", code: "123456", name: "" });
    const bn = composeAuthOtpMessage({ ...store, language: "bn" }, { purpose: "customer_login", code: "123456", name: "" });
    expect(en.sms).toBe("123456 is your River & Loom code. It expires in 5 minutes. Don't share it.");
    expect(bn.sms).toBe("River & Loom-এর কোড 123456। মেয়াদ ৫ মিনিট।");
    expect(en.sms.length).toBeLessThanOrEqual(160);
    expect(bn.sms.length).toBeLessThanOrEqual(70);
  });

  it("names the action for recovery and lookup codes and escapes the store name", () => {
    const unsafe = { ...store, name: '<img src=x onerror="alert(1)">' };
    const recovery = composeAuthOtpMessage(unsafe, { purpose: "order_payment_recovery", code: "123456", name: "Rahim" });
    const lookup = composeAuthOtpMessage(store, { purpose: "order_lookup", code: "123456", name: "Rahim", orderNumber: 1057 });
    const bnLookup = composeAuthOtpMessage({ ...store, language: "bn" }, { purpose: "order_lookup", code: "123456", name: "", orderNumber: 1057 });
    const unnumbered = composeAuthOtpMessage(store, { purpose: "order_lookup", code: "123456", name: "" });
    expect(recovery.html).not.toMatch(/<img\b/);
    expect(recovery.text).toContain("Hi Rahim,");
    expect(recovery.text).toContain("finish paying for your order");
    expect(lookup.text).toContain("Use this code to view order #1057 at River & Loom.");
    expect(bnLookup.text).toContain("অর্ডার #1057 দেখতে");
    expect(unnumbered.text).toContain("Use this code to view your order at River & Loom.");
    expect(lookup.text).toContain("This code expires in 5 minutes.");
  });
});
