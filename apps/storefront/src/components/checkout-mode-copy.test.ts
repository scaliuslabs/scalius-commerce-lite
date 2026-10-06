// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
} from "@scalius/shared/checkout-language";

// Regression: the checkout's phone help said "The courier calls this number"
// for pickup and for services, where no courier comes.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("checkout phone help follows the delivery mode", () => {
  it("has a sentence for delivery, pickup and no delivery in both catalogs", () => {
    for (const copy of [ENGLISH_CHECKOUT_LANGUAGE_DATA, BANGLA_CHECKOUT_LANGUAGE_DATA]) {
      expect(new Set([copy.customerPhoneHelp, copy.customerPhonePickupHelp, copy.customerPhoneServiceHelp]).size).toBe(3);
    }
    expect(ENGLISH_CHECKOUT_LANGUAGE_DATA.customerPhonePickupHelp).not.toMatch(/courier/i);
    expect(ENGLISH_CHECKOUT_LANGUAGE_DATA.customerPhoneServiceHelp).not.toMatch(/courier/i);
  });

  it("a number from another country asks for its country code, with the same three sentences", () => {
    for (const copy of [ENGLISH_CHECKOUT_LANGUAGE_DATA, BANGLA_CHECKOUT_LANGUAGE_DATA]) {
      expect(new Set([copy.customerPhoneIntlHelp, copy.customerPhoneIntlPickupHelp, copy.customerPhoneIntlServiceHelp]).size).toBe(3);
      expect(copy.customerPhoneExampleText).toContain("{example}");
    }
    for (const sentence of [
      ENGLISH_CHECKOUT_LANGUAGE_DATA.customerPhoneIntlHelp,
      ENGLISH_CHECKOUT_LANGUAGE_DATA.customerPhoneIntlPickupHelp,
      ENGLISH_CHECKOUT_LANGUAGE_DATA.customerPhoneIntlServiceHelp,
    ]) {
      expect(sentence).toMatch(/country code/i);
    }
    expect(ENGLISH_CHECKOUT_LANGUAGE_DATA.customerPhoneIntlPickupHelp).not.toMatch(/courier/i);
    expect(ENGLISH_CHECKOUT_LANGUAGE_DATA.customerPhoneIntlServiceHelp).not.toMatch(/courier/i);
  });

  it("the cart page shows the one its root's delivery need and mode make true", () => {
    const field = read("./CheckoutPhoneField.astro");
    expect(field).toContain('<span class="group-data-[delivery-need=none]:hidden group-data-[delivery-mode=pickup]:hidden">{shownHelp}</span>');
    expect(field).toContain('<span class="hidden group-data-[delivery-mode=pickup]:inline group-data-[delivery-need=none]:hidden">{shownPickupHelp || shownHelp}</span>');
    expect(field).toContain('<span class="hidden group-data-[delivery-need=none]:inline">{shownServiceHelp || shownHelp}</span>');
    const cart = read("../pages/cart.astro");
    expect(cart).toMatch(/pickupHelp=\{copy\.customerPhonePickupHelp\}\s*serviceHelp=\{copy\.customerPhoneServiceHelp\}/);
  });

  it("the no-JS checkout picks it on the server", () => {
    // Bangladesh says the merchant's three sentences; another country the country-code ones (phone-hint.ts).
    expect(read("../pages/checkout/quick.astro")).toContain("{phoneWords.hints[mode]}");
    const hints = read("../lib/checkout/phone-hint.ts");
    expect(hints).toContain("hints: { delivery: copy.help, pickup: copy.pickupHelp, none: copy.serviceHelp }");
    expect(hints).toContain("none: `${copy.intlServiceHelp}${example}`");
  });

describe("a pickup order names the pickup, not shipping", () => {
  it("in the cart summary and on the payment page", () => {
    expect(read("../pages/cart.astro")).toMatch(
      /<span class="group-data-\[delivery-mode=pickup\]:hidden">\{copy\.shippingText\}<\/span>\s*<span class="hidden group-data-\[delivery-mode=pickup\]:inline">\{copy\.deliveryModePickupText\}<\/span>/,
    );
    expect(read("../lib/checkout/index.ts")).toContain(
      'quoteDeliveryMode(quote) === "pickup" ? checkoutCopy.deliveryModePickupText : checkoutCopy.shippingText',
    );
  });
});
});
