// @vitest-environment node

import { describe, expect, it } from "vitest";
import { BANGLA_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { getGatewayPresentation } from "./checkout/gateway-presentation";
import {
  formatOrderReceiptDate,
  formatOrderSuccessPaymentMethod,
  localizeOrderReceiptGatewayPresentation,
} from "./order-success-localization";

describe("order receipt localization boundaries", () => {
  it("localizes platform gateway copy while preserving provider identity", () => {
    const presentation = localizeOrderReceiptGatewayPresentation(
      "scalius.bangladesh:sslcommerz",
      getGatewayPresentation("scalius.bangladesh:sslcommerz", "SSLCommerz"),
      BANGLA_CHECKOUT_LANGUAGE_DATA,
    );

    expect(presentation.buyerLabel).toBe("অনলাইনে পেমেন্ট করুন");
    expect(presentation.description).toContain("বিকাশ");
    expect(presentation.providerLabel).toBe("SSLCommerz");
  });

  it("names an app wallet on the receipt by the store's checkout name, never its stored id", () => {
    const bkash = "scalius.bkash:bkash";
    const gateways = [{ id: bkash, name: "bKash" }];
    expect(formatOrderSuccessPaymentMethod(bkash, BANGLA_CHECKOUT_LANGUAGE_DATA, undefined, gateways)).toBe("bKash");
    // The app was turned off since: its provider id in words.
    expect(formatOrderSuccessPaymentMethod(bkash, BANGLA_CHECKOUT_LANGUAGE_DATA)).toBe("Bkash");
    expect(formatOrderSuccessPaymentMethod("scalius.bangladesh:sslcommerz", BANGLA_CHECKOUT_LANGUAGE_DATA, undefined, gateways))
      .toBe(BANGLA_CHECKOUT_LANGUAGE_DATA.orderReceiptPaymentMethodSslcommerzText);
    expect(formatOrderSuccessPaymentMethod("unknown", BANGLA_CHECKOUT_LANGUAGE_DATA, undefined, gateways))
      .toBe(BANGLA_CHECKOUT_LANGUAGE_DATA.orderReceiptStatusNotAvailableText);
  });

  it("formats receipt time in the active locale with a safe malformed-code fallback", () => {
    const value = "2026-08-30T09:00:00.000Z";
    const english = formatOrderReceiptDate(value, "en-BD");
    const bangla = formatOrderReceiptDate(value, "bn-BD");

    expect(bangla).not.toBe(english);
    expect(formatOrderReceiptDate(value, "not a locale")).toContain("2026");
    expect(formatOrderReceiptDate("not-a-date", "bn")).toBeNull();
  });
});
