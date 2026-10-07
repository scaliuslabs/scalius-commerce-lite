import { describe, expect, it } from "vitest";
import { translate } from "~/i18n";
import { orderMessages, paymentMethodLabel } from "~/i18n/orders";
import { appPaymentMethodFallbackName, appPaymentMethodName } from "./app-payment-method";

const t = (key: keyof typeof orderMessages.en) => translate(orderMessages, key);
const BKASH = "scalius.bkash:bkash";

describe("app payment method names", () => {
  it("reads an app method by its provider id in words until its name is known", () => {
    expect(appPaymentMethodFallbackName(BKASH)).toBe("Bkash");
    expect(appPaymentMethodFallbackName("acme.pay:card-wallet")).toBe("Card wallet");
    expect(appPaymentMethodFallbackName("stripe")).toBeNull();
    expect(appPaymentMethodFallbackName("cod")).toBeNull();
    expect(appPaymentMethodFallbackName("not an id:x")).toBeNull();
  });

  it("prefers the installed provider's name", () => {
    const names = new Map([[BKASH, "bKash"]]);
    expect(appPaymentMethodName(BKASH, names)).toBe("bKash");
    expect(appPaymentMethodName("scalius.nagad:nagad", names)).toBe("Nagad");
    expect(appPaymentMethodName("stripe", names)).toBeNull();
    // SSLCommerz is the Bangladesh pack's: its old id reads as the pack's provider.
    expect(appPaymentMethodName("sslcommerz", names)).toBe("SSLCommerz");
    expect(appPaymentMethodName("sslcommerz", new Map([["scalius.bangladesh:sslcommerz", "SSLCommerz (pack)"]]))).toBe("SSLCommerz (pack)");
    expect(appPaymentMethodName("scalius.bangladesh:sslcommerz")).toBe("SSLCommerz");
  });

  it("labels orders' methods: built-in words unchanged, an app by its provider, never the stored id", () => {
    expect(paymentMethodLabel(t, "cod")).toBe("Cash on delivery");
    expect(paymentMethodLabel(t, "stripe")).toBe("Card (Stripe)");
    expect(paymentMethodLabel(t, "sslcommerz")).toBe("SSLCommerz");
    expect(paymentMethodLabel(t, "gift_card")).toBe("Gift card");
    expect(paymentMethodLabel(t, BKASH)).toBe("Bkash");
    expect(paymentMethodLabel(t, BKASH, new Map([[BKASH, "bKash"]]))).toBe("bKash");
  });
});
