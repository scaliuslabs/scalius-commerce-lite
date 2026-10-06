import { describe, expect, it } from "vitest";
import { ValidationError } from "../../errors";
import { assertOrderContact, PHONE_REQUIRED_REASON, resolveCheckoutContact } from "./contact-fields";

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

describe("the order's contact rule at checkout (orderContactNeeds)", () => {
  const optIn = { email: "optional", whatsapp: "off", phoneOptionalForDigital: true } as const;
  const digitalAbroad = {
    customerPhone: null,
    customerEmail: "buyer@example.test",
    lines: [{ fulfillmentKind: "digital" as const, isGiftCard: false }],
    paymentMethod: "stripe",
    depositPlan: false,
    countryCode: "US",
  };
  const refusal = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      return error instanceof ValidationError ? error.details : error;
    }
    return null;
  };

  it("lets an opted-in digital order abroad go without a phone, never without an email", () => {
    expect(() => assertOrderContact(optIn, digitalAbroad)).not.toThrow();
    expect(() => assertOrderContact(optIn, { ...digitalAbroad, customerEmail: null })).toThrow("Enter your email address.");
  });

  it("requires a phone, with the reason, for every other order", () => {
    const cases: Array<[string, Parameters<typeof assertOrderContact>]> = [
      ["not_opted_in", [{ ...optIn, phoneOptionalForDigital: false }, digitalAbroad]],
      ["not_opted_in", [undefined, digitalAbroad]],
      ["delivery", [optIn, { ...digitalAbroad, lines: [...digitalAbroad.lines, { fulfillmentKind: "physical", isGiftCard: false }] }]],
      ["cash_on_delivery", [optIn, { ...digitalAbroad, lines: [{ fulfillmentKind: "service", isGiftCard: false }], paymentMethod: "cod" }]],
      ["partial_payment", [optIn, { ...digitalAbroad, depositPlan: true }]],
      ["bangladesh", [optIn, { ...digitalAbroad, countryCode: "BD" }]],
      ["bangladesh", [optIn, { ...digitalAbroad, countryCode: null }]],
      ["email_hidden", [{ ...optIn, email: "hidden" }, digitalAbroad]],
    ];
    for (const [reason, args] of cases) {
      expect(refusal(() => assertOrderContact(...args)), reason).toMatchObject({
        field: "customerPhone",
        reason: PHONE_REQUIRED_REASON,
        phoneRequiredBecause: reason,
      });
    }
  });

  it("accepts any order that carries a phone", () => {
    expect(() => assertOrderContact(undefined, { ...digitalAbroad, customerPhone: phone, customerEmail: null, paymentMethod: "cod", countryCode: "BD" }))
      .not.toThrow();
  });

  it("keeps a separate WhatsApp number for an order without a phone", () => {
    expect(resolveCheckoutContact({ email: "optional", whatsapp: "separate" }, { customerPhone: null, customerEmail: null, customerWhatsapp: "01812000001" }).customerWhatsapp)
      .toBe("+8801812000001");
  });
});
