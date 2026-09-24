import { describe, expect, it } from "vitest";
import { storeContactLinks } from "./store-contact";

describe("store contact links", () => {
  it("links a Bangladesh mobile to a call and a WhatsApp chat, and the email to mail", () => {
    expect(storeContactLinks({ phone: " 01711-000000 ", email: " shop@example.com " })).toEqual([
      { kind: "phone", href: "tel:+8801711000000", label: "01711-000000" },
      { kind: "whatsapp", href: "https://wa.me/8801711000000", label: "WhatsApp" },
      { kind: "email", href: "mailto:shop@example.com", label: "shop@example.com" },
    ]);
  });

  it("reads +880 and Bengali digits the same way", () => {
    expect(storeContactLinks({ phone: "+৮৮০১৭১১০০০০০০" }).map((link) => link.href)).toEqual([
      "tel:+8801711000000",
      "https://wa.me/8801711000000",
    ]);
  });

  it("offers no WhatsApp chat for a landline or a number outside Bangladesh", () => {
    expect(storeContactLinks({ phone: "02-9876543" }).map((link) => link.kind)).toEqual(["phone"]);
    expect(storeContactLinks({ phone: "+44 20 7946 0958" }).map((link) => link.kind)).toEqual(["phone"]);
  });

  it("shows only what is set", () => {
    expect(storeContactLinks({ email: "help@example.com" })).toEqual([
      { kind: "email", href: "mailto:help@example.com", label: "help@example.com" },
    ]);
  });

  it.each([
    [null],
    [undefined],
    [{}],
    [{ phone: "", email: "" }],
    [{ phone: "   ", email: "  " }],
    [{ phone: "12", email: "not an email" }],
  ])("is empty when the store has no usable contact (%j)", (business) => {
    expect(storeContactLinks(business)).toEqual([]);
  });
});
