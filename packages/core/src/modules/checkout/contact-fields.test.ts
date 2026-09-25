import { describe, expect, it } from "vitest";
import { resolveCheckoutContact } from "./contact-fields";

const phone = "+8801712000001";

describe("checkout contact fields follow Customer accounts", () => {
  it("requires, keeps or drops the email", () => {
    expect(() => resolveCheckoutContact({ email: "required", whatsapp: "off" }, { customerPhone: phone, customerEmail: " " }))
      .toThrow("Enter your email address.");
    expect(resolveCheckoutContact({ email: "optional", whatsapp: "off" }, { customerPhone: phone, customerEmail: "A@B.test" }))
      .toEqual({ customerEmail: "a@b.test", customerWhatsapp: null });
    expect(resolveCheckoutContact({ email: "optional", whatsapp: "off" }, { customerPhone: phone, customerEmail: null }))
      .toEqual({ customerEmail: null, customerWhatsapp: null });
    expect(resolveCheckoutContact({ email: "hidden", whatsapp: "off" }, { customerPhone: phone, customerEmail: "a@b.test" }))
      .toEqual({ customerEmail: null, customerWhatsapp: null });
  });

  it("keeps a separate WhatsApp number only in separate mode and only when it differs from the phone", () => {
    const input = { customerPhone: phone, customerEmail: null, customerWhatsapp: "01812000001" };
    expect(resolveCheckoutContact({ email: "optional", whatsapp: "separate" }, input).customerWhatsapp).toBe("+8801812000001");
    expect(resolveCheckoutContact({ email: "optional", whatsapp: "same_as_phone" }, input).customerWhatsapp).toBeNull();
    expect(resolveCheckoutContact({ email: "optional", whatsapp: "separate" }, { ...input, customerWhatsapp: "01712000001" }).customerWhatsapp)
      .toBeNull();
    expect(() => resolveCheckoutContact({ email: "optional", whatsapp: "separate" }, { ...input, customerWhatsapp: "123" }))
      .toThrow("Enter a valid WhatsApp number.");
  });
});
