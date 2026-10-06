import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOMER_IDENTITY,
  NO_PHONE,
  checkoutContactFields,
  customerIdentityProblem,
  isChannelCollected,
  normalizeCustomerIdentitySettings,
  offeredChannels,
  orderChannelTarget,
  orderCodeChannels,
  newAccountPhoneNeed,
  orderContactNeeds,
  orderPaymentKind,
  phoneOrNull,
  resolveSignInChannel,
  storedPhone,
  type EmailCollectionMode,
  type OrderContactLine,
  type OrderPaymentKind,
} from "./customer-auth-policy";

describe("customer identity settings", () => {
  it("keeps a valid document and resets anything else to the defaults", () => {
    const saved = { email: "optional", whatsapp: "separate", channels: ["sms", "whatsapp", "sms"] };
    expect(normalizeCustomerIdentitySettings(saved)).toEqual({
      email: "optional",
      whatsapp: "separate",
      channels: ["sms", "whatsapp"],
      phoneOptionalForDigital: false,
    });
    expect(normalizeCustomerIdentitySettings({ ...saved, channels: ["email"], phoneOptionalForDigital: true }))
      .toEqual({ email: "optional", whatsapp: "separate", channels: ["email"], phoneOptionalForDigital: true });
    for (const stale of [
      { email: "optional", whatsapp: "off", channels: ["email"], phoneOptionalForDigital: "yes" },
      // A phoneless buyer must keep email: asked at checkout, and codes by email.
      { email: "hidden", whatsapp: "off", channels: ["sms"], phoneOptionalForDigital: true },
      { email: "optional", whatsapp: "off", channels: ["sms"], phoneOptionalForDigital: true },
      undefined,
      { authVerificationMethod: "sms_otp", policy: { otpChannels: ["sms"] } },
      { email: "optional", whatsapp: "off", channels: [] },
      { email: "hidden", whatsapp: "off", channels: ["email"] },
      { email: "maybe", whatsapp: "off", channels: ["sms"] },
    ]) {
      expect(normalizeCustomerIdentitySettings(stale)).toEqual(DEFAULT_CUSTOMER_IDENTITY);
    }
  });

  it("lets a channel be chosen only when its contact field is collected", () => {
    expect(isChannelCollected({ email: "hidden", whatsapp: "off" }, "email")).toBe(false);
    expect(isChannelCollected({ email: "optional", whatsapp: "off" }, "email")).toBe(true);
    expect(isChannelCollected({ email: "hidden", whatsapp: "off" }, "whatsapp")).toBe(false);
    expect(isChannelCollected({ email: "hidden", whatsapp: "same_as_phone" }, "whatsapp")).toBe(true);
    expect(isChannelCollected({ email: "hidden", whatsapp: "off" }, "sms")).toBe(true);
    const off = { phoneOptionalForDigital: false };
    expect(customerIdentityProblem({ email: "hidden", whatsapp: "off", channels: ["sms", "email"], ...off }))
      .toBe("Email codes need checkout to ask for the email address.");
    expect(customerIdentityProblem({ email: "hidden", whatsapp: "off", channels: ["whatsapp"], ...off }))
      .toBe("WhatsApp codes need checkout to ask for a WhatsApp number.");
    expect(customerIdentityProblem({ email: "required", whatsapp: "off", channels: [], ...off }))
      .toBe("Choose at least one way to send codes.");
    expect(customerIdentityProblem({ email: "hidden", whatsapp: "off", channels: ["sms"], phoneOptionalForDigital: true }))
      .toBe("Orders without a phone need checkout to ask for the email address.");
    expect(customerIdentityProblem({ email: "optional", whatsapp: "off", channels: ["sms"], phoneOptionalForDigital: true }))
      .toBe("Orders without a phone need email codes, so those buyers can sign in and find their orders.");
    expect(customerIdentityProblem({ email: "optional", whatsapp: "off", channels: ["sms", "email"], phoneOptionalForDigital: true }))
      .toBeNull();
  });

  it("offers only chosen channels that can send, and never adds one (fail closed)", () => {
    const settings = { email: "required", whatsapp: "off", channels: ["email"], phoneOptionalForDigital: false } as const;
    const chosen = { ...settings, channels: [...settings.channels] };
    expect(offeredChannels(chosen, { email: false, sms: true, whatsapp: true })).toEqual([]);
    expect(offeredChannels(chosen, { email: true, sms: true })).toEqual(["email"]);
  });

  it("resolves a sign-in channel from the chosen ones only", () => {
    expect(resolveSignInChannel(["email"], "phone", "sms")).toBeNull();
    expect(resolveSignInChannel(["email", "whatsapp", "sms"], "phone")).toBe("whatsapp");
    expect(resolveSignInChannel(["email", "whatsapp", "sms"], "phone", "sms")).toBe("sms");
    expect(resolveSignInChannel(["email", "sms"], "email", "sms")).toBe("email");
  });

  it("shapes the checkout contact fields; phone is never optional", () => {
    expect(checkoutContactFields({ email: "hidden", whatsapp: "same_as_phone" })).toEqual({ email: "hidden", whatsapp: "hidden" });
    expect(checkoutContactFields({ email: "required", whatsapp: "separate" })).toEqual({ email: "required", whatsapp: "optional" });
  });

  it("sends order codes only to contacts saved on the order", () => {
    const order = { customerPhone: "+8801712000001", customerEmail: " Buyer@Example.test ", customerWhatsapp: "+8801812000001" };
    expect(orderChannelTarget({ whatsapp: "separate" }, "whatsapp", order)).toBe("+8801812000001");
    expect(orderChannelTarget({ whatsapp: "same_as_phone" }, "whatsapp", order)).toBe("+8801712000001");
    expect(orderChannelTarget({ whatsapp: "separate" }, "whatsapp", { ...order, customerWhatsapp: null })).toBe("+8801712000001");
    expect(orderChannelTarget({ whatsapp: "off" }, "whatsapp", order)).toBeNull();
    const off = { phoneOptionalForDigital: false };
    expect(orderCodeChannels(
      { email: "optional", whatsapp: "off", channels: ["email", "sms"], ...off },
      { ...order, customerEmail: null },
    )).toEqual([{ channel: "sms", target: "+8801712000001" }]);
    expect(orderCodeChannels({ email: "optional", whatsapp: "off", channels: ["email"], ...off }, order))
      .toEqual([{ channel: "email", target: "buyer@example.test" }]);
    // An order placed without a phone is reached by email only.
    expect(orderCodeChannels(
      { email: "optional", whatsapp: "same_as_phone", channels: ["sms", "whatsapp", "email"], ...off },
      { customerPhone: null, customerEmail: "buyer@example.test", customerWhatsapp: null },
    )).toEqual([{ channel: "email", target: "buyer@example.test" }]);
  });
});

describe("stored phones", () => {
  it("stores a missing phone as NO_PHONE and reads it back as null", () => {
    expect(storedPhone(null)).toBe(NO_PHONE);
    expect(storedPhone("  ")).toBe(NO_PHONE);
    expect(storedPhone("+8801712000001")).toBe("+8801712000001");
    expect(phoneOrNull(NO_PHONE)).toBeNull();
    expect(phoneOrNull(storedPhone(undefined))).toBeNull();
    expect(phoneOrNull("+14155550100")).toBe("+14155550100");
  });
});

describe("the order's contact rule (owner decision 2026-10-07)", () => {
  const physical: OrderContactLine = { fulfillmentKind: "physical", isGiftCard: false };
  const digital: OrderContactLine = { fulfillmentKind: "digital", isGiftCard: false };
  const service: OrderContactLine = { fulfillmentKind: "service", isGiftCard: false };
  const giftCard: OrderContactLine = { fulfillmentKind: "digital", isGiftCard: true };
  const lineSets: Record<string, OrderContactLine[]> = {
    physical: [physical],
    digital: [digital],
    service: [service],
    "gift card": [giftCard],
    "digital + service + gift card": [digital, service, giftCard],
    "mixed (physical + digital)": [physical, digital],
    "mixed (physical + gift card)": [giftCard, physical],
    none: [],
  };
  const payments: OrderPaymentKind[] = ["cod", "online", "partial", "gift_card"];
  const countries: Array<string | null> = ["BD", "bd", null, "US", "IN"];
  const emailModes: EmailCollectionMode[] = ["required", "optional", "hidden"];

  // The decision, written independently of the implementation.
  function phoneMayBeOptional(input: {
    lines: OrderContactLine[];
    payment: OrderPaymentKind;
    country: string | null;
    optIn: boolean;
    email: EmailCollectionMode;
  }): boolean {
    const nothingToDeliver = input.lines.length > 0
      && input.lines.every((line) => line.isGiftCard || line.fulfillmentKind === "digital" || line.fulfillmentKind === "service");
    const paidInFullNow = input.payment === "online" || input.payment === "gift_card";
    const outsideBangladesh = input.country !== null && input.country.toUpperCase() !== "BD";
    return input.optIn && input.email !== "hidden" && nothingToDeliver && paidInFullNow && outsideBangladesh;
  }

  it("matches the decision over every combination", () => {
    let optional = 0;
    let combinations = 0;
    for (const [, lines] of Object.entries(lineSets)) {
      for (const payment of payments) {
        for (const country of countries) {
          for (const optIn of [false, true]) {
            for (const email of emailModes) {
              combinations += 1;
              const needs = orderContactNeeds(
                { email, phoneOptionalForDigital: optIn },
                { lines, payment, countryCode: country },
              );
              const expectOptional = phoneMayBeOptional({ lines, payment, country, optIn, email });
              expect(needs.phone, JSON.stringify({ lines, payment, country, optIn, email }))
                .toBe(expectOptional ? "optional" : "required");
              if (expectOptional) {
                optional += 1;
                // Without a phone the buyer always keeps email.
                expect(needs.email).toBe("required");
                expect(needs.phoneReason).toBeNull();
              } else {
                // A required phone leaves email to the merchant's setting.
                expect(needs.email).toBe(email);
                expect(needs.phoneReason).not.toBeNull();
              }
            }
          }
        }
      }
    }
    expect(combinations).toBe(8 * 4 * 5 * 2 * 3);
    // Opt-in on, email asked (2 modes), 4 line sets with nothing to deliver,
    // paid in full now (2 kinds), outside Bangladesh (2 countries).
    expect(optional).toBe(2 * 4 * 2 * 2);
  });

  it("names the first reason a phone is required", () => {
    const optIn = { email: "optional", phoneOptionalForDigital: true } as const;
    const abroad = { payment: "online", countryCode: "US" } as const;
    expect(orderContactNeeds({ ...optIn, phoneOptionalForDigital: false }, { lines: [digital], ...abroad }).phoneReason).toBe("not_opted_in");
    expect(orderContactNeeds({ ...optIn, email: "hidden" }, { lines: [digital], ...abroad }).phoneReason).toBe("email_hidden");
    expect(orderContactNeeds(optIn, { lines: [], ...abroad }).phoneReason).toBe("no_lines");
    expect(orderContactNeeds(optIn, { lines: [digital, physical], ...abroad }).phoneReason).toBe("delivery");
    expect(orderContactNeeds(optIn, { lines: [service], payment: "cod", countryCode: "US" }).phoneReason).toBe("cash_on_delivery");
    expect(orderContactNeeds(optIn, { lines: [digital], payment: "partial", countryCode: "US" }).phoneReason).toBe("partial_payment");
    expect(orderContactNeeds(optIn, { lines: [digital], payment: "online", countryCode: "BD" }).phoneReason).toBe("bangladesh");
    expect(orderContactNeeds(optIn, { lines: [digital], payment: "online", countryCode: undefined }).phoneReason).toBe("bangladesh");
  });

  it("reads the payment kind from the method and the store's deposit plan", () => {
    expect(orderPaymentKind("cod", { depositPlan: false })).toBe("cod");
    expect(orderPaymentKind("cod", { depositPlan: true })).toBe("cod");
    expect(orderPaymentKind("gift_card", { depositPlan: true })).toBe("gift_card");
    expect(orderPaymentKind("stripe", { depositPlan: false })).toBe("online");
    expect(orderPaymentKind("stripe", { depositPlan: true })).toBe("partial");
    expect(orderPaymentKind("acme-pay:card", { depositPlan: false })).toBe("online");
  });

  it("lets a new account skip the phone only after an email sign-up with the opt-in", () => {
    expect(newAccountPhoneNeed({ phoneOptionalForDigital: false }, "email")).toBe("required");
    expect(newAccountPhoneNeed({ phoneOptionalForDigital: true }, "email")).toBe("optional");
    expect(newAccountPhoneNeed({ phoneOptionalForDigital: true }, "phone")).toBe("required");
  });

  it("keeps today's behaviour for a store that has not opted in", () => {
    for (const lines of Object.values(lineSets)) {
      for (const payment of payments) {
        for (const email of emailModes) {
          expect(orderContactNeeds({ email, phoneOptionalForDigital: false }, { lines, payment, countryCode: "US" }))
            .toEqual({ phone: "required", email, phoneReason: "not_opted_in" });
        }
      }
    }
  });
});
