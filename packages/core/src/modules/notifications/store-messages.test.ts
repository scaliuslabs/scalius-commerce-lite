import { describe, expect, it } from "vitest";
import { composeAuthOtpMessage } from "./store-messages";

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
    const lookup = composeAuthOtpMessage(store, { purpose: "order_lookup", code: "123456", name: "Rahim" });
    expect(recovery.html).not.toMatch(/<img\b/);
    expect(recovery.text).toContain("Hi Rahim,");
    expect(recovery.text).toContain("finish paying for your order");
    expect(lookup.text).toContain("Use this code to view your order at River & Loom.");
    expect(lookup.text).toContain("This code expires in 5 minutes.");
  });
});
