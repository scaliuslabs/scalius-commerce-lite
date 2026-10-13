import { describe, expect, it } from "vitest";
import { marketingConsentFormValues, marketingConsentOrderField } from "./marketing-consent";
describe("independent checkout marketing choices", () => {
  it("never treats a legacy umbrella value, unchecked boxes or a forged push choice as channel consent", () => {
    expect(marketingConsentOrderField("en")).toEqual({});
    expect(marketingConsentOrderField({ marketingConsent: "bn", marketingConsent_push: "bn" })).toEqual({});
    expect(marketingConsentOrderField(new FormData())).toEqual({});
  });
  it("carries only selected channels identically through native and hydrated checkout", () => {
    const fields = { marketingConsent_email: "bn", marketingConsent_whatsapp: "bn", marketingConsent_sms: "" };
    const form = new FormData(); Object.entries(fields).forEach(([key, value]) => form.set(key, value));
    const expected = { marketingConsent: { language: "bn", channels: ["email", "whatsapp"] } };
    expect(marketingConsentOrderField(fields)).toEqual(expected);
    expect(marketingConsentOrderField(form)).toEqual(expected);
    expect(marketingConsentFormValues(form)).toEqual({ marketingConsent_email: "bn", marketingConsent_whatsapp: "bn" });
  });
});
