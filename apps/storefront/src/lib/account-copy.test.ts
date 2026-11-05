import { describe, expect, it } from "vitest";
import { accountCopy } from "./account-copy";

describe("accountCopy — contact fields (manual COD deposit)", () => {
  it("returns English contact fields", () => {
    const copy = accountCopy("en");
    expect(copy.contactPhoneText).toBe("Phone");
    expect(copy.contactEmailText).toBe("Email");
    expect(copy.contactWhatsappText).toBe("WhatsApp");
    expect(copy.contactStoreText).toBe("Store contact");
  });

  it("returns Bangla contact fields", () => {
    const copy = accountCopy("bn");
    expect(copy.contactPhoneText).toBe("ফোন");
    expect(copy.contactEmailText).toBe("ইমেইল");
    expect(copy.contactWhatsappText).toBe("হোয়াটসঅ্যাপ");
    expect(copy.contactStoreText).toBe("স্টোরের যোগাযোগ");
  });

  it("has identical keys in EN and BN (no missing keys)", () => {
    const en = accountCopy("en");
    const bn = accountCopy("bn");
    const enKeys = Object.keys(en);
    const bnKeys = Object.keys(bn);
    expect(bnKeys.sort()).toEqual(enKeys.sort());
  });

  it("all contact fields are non-empty strings in both languages", () => {
    for (const lang of ["en", "bn"] as const) {
      const copy = accountCopy(lang);
      expect(typeof copy.contactPhoneText).toBe("string");
      expect(copy.contactPhoneText.length).toBeGreaterThan(0);
      expect(typeof copy.contactEmailText).toBe("string");
      expect(copy.contactEmailText.length).toBeGreaterThan(0);
      expect(typeof copy.contactWhatsappText).toBe("string");
      expect(copy.contactWhatsappText.length).toBeGreaterThan(0);
      expect(typeof copy.contactStoreText).toBe("string");
      expect(copy.contactStoreText.length).toBeGreaterThan(0);
    }
  });
});
