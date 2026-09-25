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

  it("the cart page shows the one its root's delivery need and mode make true", () => {
    const field = read("./CheckoutPhoneField.astro");
    expect(field).toContain('<span class="group-data-[delivery-need=none]:hidden group-data-[delivery-mode=pickup]:hidden">{help}</span>');
    expect(field).toContain('<span class="hidden group-data-[delivery-mode=pickup]:inline group-data-[delivery-need=none]:hidden">{pickupHelp || help}</span>');
    expect(field).toContain('<span class="hidden group-data-[delivery-need=none]:inline">{serviceHelp || help}</span>');
    const cart = read("../pages/cart.astro");
    expect(cart).toMatch(/pickupHelp=\{copy\.customerPhonePickupHelp\}\s*serviceHelp=\{copy\.customerPhoneServiceHelp\}/);
  });

  it("the no-JS checkout picks it on the server", () => {
    expect(read("../pages/checkout/quick.astro")).toContain(
      '{mode === "pickup" ? copy.customerPhonePickupHelp : mode === "none" ? copy.customerPhoneServiceHelp : copy.customerPhoneHelp}',
    );
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
