// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { storefrontSourcePath } from "../test-source-paths";

const checkoutPage = readFileSync(storefrontSourcePath("pages", "checkout.astro"), "utf8");
/** The inline script that runs while the page is parsed, before any module loads. */
const prePaintScript = checkoutPage.match(/<script is:inline>([\s\S]*?checkoutPageRoot[\s\S]*?)<\/script>/)?.[1] ?? "";

/**
 * Without a checkout session the page shows "return to your cart" at first
 * paint (CLS 0), instead of moving it in when the checkout script loads.
 */
describe("checkout page first paint", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="checkoutPageRoot" data-checkout-state="loading"><a id="checkoutRecoveryAction" href="/cart" hidden>Back</a></div>`;
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  const run = () => {
    new Function(prePaintScript)();
    return {
      state: document.getElementById("checkoutPageRoot")!.dataset.checkoutState,
      linkHidden: document.getElementById("checkoutRecoveryAction")!.hidden,
    };
  };

  it("paints the missing-session state when the browser holds no checkout", () => {
    expect(prePaintScript).not.toBe("");
    expect(run()).toEqual({ state: "missing", linkHidden: false });
  });

  it("leaves a checkout in progress, and an order just placed, to the page script", () => {
    sessionStorage.setItem("scalius_checkout_data", "{}");
    expect(run()).toEqual({ state: "loading", linkHidden: true });
    sessionStorage.clear();
    sessionStorage.setItem("scalius_last_order", "ord_1");
    expect(run()).toEqual({ state: "loading", linkHidden: true });
  });

  it("server-renders the missing-session message and hides the session's sections with CSS only in that state", () => {
    expect(checkoutPage).toMatch(/id="errorMsg"[\s\S]*?group-data-\[checkout-state=missing\]:block[\s\S]*?>\{copy\.checkoutDetailsMissingText\}<\/div>/);
    for (const id of ["orderSummary", "giftCardSection", "paymentMethods"]) {
      expect(checkoutPage).toMatch(new RegExp(`id="${id}"[\\s\\S]{0,200}?group-data-\\[checkout-state=missing\\]:hidden`));
    }
    // The script reads the same session keys the checkout and receipt modules write.
    const checkoutSource = readFileSync(storefrontSourcePath("lib", "checkout", "index.ts"), "utf8");
    const receiptSource = readFileSync(storefrontSourcePath("lib", "checkout", "receipt-finalization.ts"), "utf8");
    expect(checkoutSource).toContain('sessionStorage.getItem("scalius_checkout_data")');
    expect(receiptSource).toContain('LAST_ORDER_KEY = "scalius_last_order"');
  });
});
