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
    localStorage.setItem("cart", JSON.stringify({ items: {} }));
    expect(run()).toBe("empty");
    document.getElementById("cartPageRoot")!.dataset.cartState = "loading";
    localStorage.setItem("cart", JSON.stringify({ items: { line: { id: "p1", name: "Panjabi", variantId: "v1" } } }));
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
    localStorage.setItem("cart", "{not json");
    expect(run()).toBe("loading");
  });
});
