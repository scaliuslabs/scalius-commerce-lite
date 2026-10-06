// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { applyCheckoutContactNeeds, checkoutContactNeeds, readCheckoutPhoneNeed } from "./contact-need";
import { checkoutAddressForMode } from "./delivery-mode";

const optIn = { email: "optional", phoneOptionalForDigital: true } as const;
const digital = [{ fulfillmentKind: "digital" }];

describe("checkout contact need (the shared rule in the browser)", () => {
  it("lets an opted-in digital cart abroad go without a phone, with email required", () => {
    expect(checkoutContactNeeds({ identity: optIn, lines: digital, cashEnabled: true, partialPaymentEnabled: false, countryCode: "US" }))
      .toEqual({ phone: "optional", email: "required", phoneReason: null });
  });

  it("assumes the payment that needs the most before the buyer picks one", () => {
    const service = [{ fulfillmentKind: "service" }];
    // A service line can be paid in cash when cash is on: a phone is needed.
    expect(checkoutContactNeeds({ identity: optIn, lines: service, cashEnabled: true, partialPaymentEnabled: false, countryCode: "US" }).phoneReason)
      .toBe("cash_on_delivery");
    expect(checkoutContactNeeds({ identity: optIn, lines: service, cashEnabled: false, partialPaymentEnabled: false, countryCode: "US" }).phone)
      .toBe("optional");
    // Digital lines are never paid in cash; a deposit plan still needs a phone.
    expect(checkoutContactNeeds({ identity: optIn, lines: digital, cashEnabled: true, partialPaymentEnabled: true, countryCode: "US" }).phoneReason)
      .toBe("partial_payment");
  });

  it("keeps the phone required for physical, unknown-kind, Bangladesh and not-opted-in carts", () => {
    const base = { identity: optIn, cashEnabled: false, partialPaymentEnabled: false, countryCode: "US" };
    expect(checkoutContactNeeds({ ...base, lines: [{ fulfillmentKind: "physical" }] }).phoneReason).toBe("delivery");
    expect(checkoutContactNeeds({ ...base, lines: [{}] }).phoneReason).toBe("delivery");
    expect(checkoutContactNeeds({ ...base, lines: digital, countryCode: "BD" }).phoneReason).toBe("bangladesh");
    expect(checkoutContactNeeds({ ...base, lines: digital, countryCode: null }).phoneReason).toBe("bangladesh");
    expect(checkoutContactNeeds({ ...base, identity: { ...optIn, phoneOptionalForDigital: false }, lines: digital }).phoneReason)
      .toBe("not_opted_in");
  });
});

describe("the checkout form shows the decision", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("marks the page, the phone and the email", () => {
    document.body.innerHTML = `<div id="cartPageRoot"><input id="customerPhone-input" aria-required="true"><input id="customerEmail"></div>`;
    expect(readCheckoutPhoneNeed()).toBe("required");
    applyCheckoutContactNeeds({ phone: "optional", email: "required" });
    expect(readCheckoutPhoneNeed()).toBe("optional");
    expect(document.getElementById("customerPhone-input")?.getAttribute("aria-required")).toBe("false");
    expect((document.getElementById("customerEmail") as HTMLInputElement).required).toBe(true);
    applyCheckoutContactNeeds({ phone: "required", email: "optional" });
    expect(readCheckoutPhoneNeed()).toBe("required");
    expect((document.getElementById("customerEmail") as HTMLInputElement).required).toBe(false);
  });
});

describe("an order with nothing to ship carries its market's country", () => {
  it("sends the posted market country outside Bangladesh, and nothing for Bangladesh", () => {
    expect(checkoutAddressForMode("none", { orderCountryCode: "us" })).toMatchObject({ shippingCountryCode: "US", shippingAddress: null });
    expect(checkoutAddressForMode("none", { orderCountryCode: "BD" })).not.toHaveProperty("shippingCountryCode");
    expect(checkoutAddressForMode("none", {})).not.toHaveProperty("shippingCountryCode");
    // Pickup and delivery are unchanged by it.
    expect(checkoutAddressForMode("pickup", { orderCountryCode: "US" })).not.toHaveProperty("shippingCountryCode");
  });
});
