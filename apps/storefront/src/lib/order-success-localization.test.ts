// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "./test-source-paths";
import { BANGLA_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { getGatewayPresentation } from "./checkout/gateway-presentation";
import {
  formatOrderReceiptDate,
  localizeOrderReceiptGatewayPresentation,
} from "./order-success-localization";

const pageSource = readFileSync(
  storefrontSourcePath("pages/order-success.astro"),
  "utf8",
);
const buttonsSource = readFileSync(
  storefrontSourcePath("components/OrderSuccessButtons.tsx"),
  "utf8",
);

describe("order receipt localization boundaries", () => {
  it("uses the active checkout language for server and hydrated receipt UI", () => {
    const layoutOpeningTag = pageSource.match(/<Layout[\s\S]*?>/)?.[0] ?? "";

    expect(pageSource).toContain("getActiveCheckoutLanguage()");
    expect(pageSource).toContain("checkoutLanguageBaseCode(checkoutLanguage.code)");
    expect(pageSource).toContain("window.__CHECKOUT_LANGUAGE__=");
    expect(pageSource).toContain("getOrderSuccessViewState(order, copy, paymentResult)");
    expect(pageSource).toContain("<CheckoutProgress");
    expect(pageSource).toContain("copy={copy}");
    expect(pageSource).toContain("<OrderSuccessButtons");
    expect(layoutOpeningTag).not.toContain("noindex");
    expect(pageSource.match(/name="robots"/g)).toHaveLength(1);
    expect(pageSource).toContain('content="noindex,nofollow"');
  });

  it("does not render raw payment, provider, support, or API prose", () => {
    expect(pageSource).not.toContain("event.message");
    expect(pageSource).not.toContain("result.error ||");
    expect(pageSource).not.toContain("typeof data.error ===");
    expect(pageSource).not.toContain("error instanceof Error ? error.message");
    expect(buttonsSource).not.toContain("getApiMessage");
    expect(buttonsSource).not.toContain("error.message");
    expect(buttonsSource).not.toContain("latestSupportRequest.label");
    expect(buttonsSource).not.toContain("action.label");
    expect(buttonsSource).not.toContain("disabledReason ??");
  });

  it("keeps merchant-authored order content untouched", () => {
    expect(pageSource).toContain("order.shippingMethodName");
    expect(pageSource).toContain("order.shippingMethodDescription");
    expect(pageSource).toContain("item.productName");
    expect(pageSource).toContain("item.variantLabel");
  });

  it("localizes platform gateway copy while preserving provider identity", () => {
    const presentation = localizeOrderReceiptGatewayPresentation(
      "sslcommerz",
      getGatewayPresentation("sslcommerz", "SSLCommerz"),
      BANGLA_CHECKOUT_LANGUAGE_DATA,
    );

    expect(presentation.buyerLabel).toBe("অনলাইনে পেমেন্ট করুন");
    expect(presentation.description).toContain("বিকাশ");
    expect(presentation.providerLabel).toBe("SSLCommerz");
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
