// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { storefrontSourcePath } from "../test-source-paths";

const cartPage = readFileSync(storefrontSourcePath("pages", "cart.astro"), "utf8");
/** The inline script that runs while the page is parsed, before any module loads. */
const prePaintScript = cartPage.match(/<script is:inline>([\s\S]*?cartPageRoot[\s\S]*?)<\/script>/)?.[1] ?? "";

/**
 * PERF-01: an empty cart's message and "Continue shopping" action are HTML
 * from the server, shown at first paint, not built by the cart script.
 */
describe("cart page first paint", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="cartPageRoot" data-cart-state="loading"></div>`;
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  const run = () => {
    new Function(prePaintScript)();
    return document.getElementById("cartPageRoot")!.dataset.cartState;
  };

  it("server-renders the empty state and its continue-shopping link inside the cart lines", () => {
    const cartItems = cartPage.slice(cartPage.indexOf('id="cartItems"'), cartPage.indexOf('id="cartUndo"'));
    expect(cartItems).toContain("data-cart-empty");
    expect(cartItems).toContain("{copy.emptyCartText}");
    expect(cartItems).toContain("{copy.emptyCartDescriptionText}");
    expect(cartItems).toMatch(/<a\s+href="\/"[\s\S]*\{copy\.continueShoppingText\}/);
  });

  it("shows the empty state before the cart script loads when nothing is saved", () => {
    expect(prePaintScript).not.toBe("");
    expect(run()).toBe("empty");
  });

  it("shows it for a saved cart with no lines, and keeps loading for one with lines", () => {
    localStorage.setItem("cart:v3", JSON.stringify({ items: {} }));
    expect(run()).toBe("empty");
    document.getElementById("cartPageRoot")!.dataset.cartState = "loading";
    localStorage.setItem("cart:v3", JSON.stringify({ items: { line: { id: "p1", name: "Panjabi", variantId: "v1" } } }));
    expect(run()).toBe("loading");
  });

  it("waits for the cart script when a quick buy or a payment recovery is pending", () => {
    sessionStorage.setItem("quickBuyData", "{}");
    expect(run()).toBe("loading");
    sessionStorage.clear();
    localStorage.setItem("scalius_hosted_payment_recovery", "{}");
    expect(run()).toBe("loading");
  });

  it("keeps loading when storage cannot be read", () => {
    localStorage.setItem("cart:v3", "{not json");
    expect(run()).toBe("loading");
  });

  it("never reads a v2 cart (dropped at the v3 deploy)", () => {
    localStorage.setItem("cart", JSON.stringify({ items: { line: { id: "p1", name: "Panjabi", variantId: "v1" } } }));
    expect(run()).toBe("empty");
  });

  it("hides the delivery section before paint when nothing in the cart is physical", () => {
    const root = () => document.getElementById("cartPageRoot")!;
    localStorage.setItem("cart:v3", JSON.stringify({ items: {
      a: { id: "p1", name: "Installation", variantId: "v1", fulfillmentKind: "service" },
    } }));
    run();
    expect(root().dataset.deliveryNeed).toBe("none");

    document.body.innerHTML = `<div id="cartPageRoot" data-cart-state="loading" data-delivery-need="method"></div>`;
    localStorage.setItem("cart:v3", JSON.stringify({ items: {
      a: { id: "p1", name: "Installation", variantId: "v1", fulfillmentKind: "service" },
      b: { id: "p2", name: "Fan", variantId: "v2" },
    } }));
    run();
    // A line of unknown kind counts as physical: the address is never skipped by mistake.
    expect(root().dataset.deliveryNeed).toBe("method");
  });

  it("restores the buyer's pickup choice before paint only where the store offers the switch", () => {
    const root = () => document.getElementById("cartPageRoot")!;
    sessionStorage.setItem("scalius_checkout_form_draft", JSON.stringify({ values: { deliveryMode: "pickup" } }));
    document.body.innerHTML = `<div id="cartPageRoot" data-cart-state="loading" data-delivery-mode="delivery" data-mode-switch="false"></div>`;
    run();
    expect(root().dataset.deliveryMode).toBe("delivery");
    document.body.innerHTML = `<div id="cartPageRoot" data-cart-state="loading" data-delivery-mode="delivery" data-mode-switch="true"></div>`;
    run();
    expect(root().dataset.deliveryMode).toBe("pickup");
  });

  it("hides the address with CSS on the pickup and no-delivery paths, so nothing moves when scripts load", () => {
    expect(cartPage).toMatch(/group-data-\[delivery-mode=pickup\]:hidden[^"]*" data-address-fields/);
    expect(cartPage).toMatch(/group-data-\[delivery-need=none\]:hidden" data-delivery-section/);
    expect(cartPage).toMatch(/group-data-\[delivery-need=none\]:block"[\s\S]{0,40}data-no-delivery-note/);
  });
});
