// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { storefrontSourcePath } from "../test-source-paths";

const checkoutPage = readFileSync(storefrontSourcePath("pages", "checkout.astro"), "utf8");
/** The inline script that runs right inside the page root, before anything below it is parsed. */
const prePaintScript = checkoutPage.match(/<script is:inline>([\s\S]*?checkoutPageRoot[\s\S]*?)<\/script>/)?.[1] ?? "";

/**
 * The HTML is the empty cart (what a buyer without JavaScript has: the cart
 * lives in the browser). A checkout in progress paints its loading state, and
 * a buyer with no checkout is sent to the cart, the step they skipped,
 * instead of a Payment step with an error.
 */
describe("checkout page first paint", () => {
  let replace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = `<div id="checkoutPageRoot" data-checkout-state="missing"></div>`;
    replace = vi.fn();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  const run = (pathname = "/checkout") => {
    new Function("location", prePaintScript)({ pathname, replace });
    return document.getElementById("checkoutPageRoot")!.dataset.checkoutState;
  };

  it("sends a buyer without a checkout to the cart, keeping the market's path", () => {
    expect(prePaintScript).not.toBe("");
    expect(run()).toBe("redirect");
    expect(replace).toHaveBeenCalledExactlyOnceWith("/cart");
    replace.mockClear();
    run("/bn/checkout/");
    expect(replace).toHaveBeenCalledExactlyOnceWith("/bn/cart");
  });

  it("leaves a checkout in progress, and an order just placed, to the page script", () => {
    sessionStorage.setItem("scalius_checkout_data", "{}");
    expect(run()).toBe("loading");
    sessionStorage.clear();
    sessionStorage.setItem("scalius_last_order", "ord_1");
    expect(run()).toBe("loading");
    expect(replace).not.toHaveBeenCalled();
  });

  it("server-renders the empty cart and hides the payment step until a checkout is known", () => {
    expect(checkoutPage).toContain('id="checkoutPageRoot" data-checkout-state="missing"');
    expect(checkoutPage).toMatch(/class="hidden group-data-\[checkout-state=missing\]:block[^"]*"[\s\S]*?\{copy\.emptyCartText\}[\s\S]*?\{copy\.continueShoppingText\}/);
    expect(checkoutPage).toMatch(/group-data-\[checkout-state=missing\]:hidden group-data-\[checkout-state=redirect\]:hidden">\s*<CheckoutProgress/);
    expect(checkoutPage).toMatch(/lg:gap-10 group-data-\[checkout-state=missing\]:hidden group-data-\[checkout-state=redirect\]:hidden">\s*<aside\s+id="orderSummary"/);
    // The script reads the same session keys the checkout and receipt modules write.
    const checkoutSource = readFileSync(storefrontSourcePath("lib", "checkout", "index.ts"), "utf8");
    const receiptSource = readFileSync(storefrontSourcePath("lib", "checkout", "receipt-finalization.ts"), "utf8");
    expect(checkoutSource).toContain('sessionStorage.getItem("scalius_checkout_data")');
    expect(receiptSource).toContain('LAST_ORDER_KEY = "scalius_last_order"');
  });
});
