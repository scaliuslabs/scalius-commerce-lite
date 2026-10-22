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

  it("reveals the quick-buy storage notice from the URL before paint, never from the server", () => {
    // The cart HTML is one shared, cached shell: the server must not read the query.
    const frontmatter = cartPage.slice(0, cartPage.indexOf("\n---", 4));
    expect(frontmatter).not.toMatch(/Astro\.url\.search/);
    const noticeScript =
      cartPage.match(/<script is:inline>((?:(?!<\/script>)[\s\S])*?getElementById\("quickBuyStorageNotice"\)[\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(noticeScript).not.toBe("");
    const reveal = (search: string) => {
      document.body.innerHTML = `<div id="quickBuyStorageNotice" hidden>Storage blocked</div>`;
      window.history.replaceState(null, "", `/cart${search}`);
      new Function(noticeScript)();
      return document.getElementById("quickBuyStorageNotice")!.hidden;
    };

    expect(reveal("")).toBe(true);
    expect(reveal("?quickBuyStorage=other")).toBe(true);
    expect(reveal("?quickBuyStorage=blocked")).toBe(false);
    window.history.replaceState(null, "", "/");
  });

  it("hides the address with CSS on the pickup and no-delivery paths, so nothing moves when scripts load", () => {
    expect(cartPage).toMatch(/group-data-\[delivery-mode=pickup\]:hidden[^"]*" data-address-fields/);
    expect(cartPage).toMatch(/group-data-\[delivery-need=none\]:hidden" data-delivery-section/);
    expect(cartPage).toMatch(/group-data-\[delivery-need=none\]:block"[\s\S]{0,40}data-no-delivery-note/);
  });

  it("without scripts shows only the note, never an endless loading skeleton", () => {
    const noscript = cartPage.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? "";
    expect(noscript).toContain("#cartPageRoot [data-cart-grid] { display: none; }");
    expect(noscript).toContain("copy.noScriptText");
    expect(cartPage).toMatch(/<div class="grid [^"]*" data-cart-grid>/);
  });

  describe("phone checkout order (P14)", () => {
    const layoutScript =
      cartPage.match(/<script is:inline>((?:(?!<\/script>)[\s\S])*?getElementById\("orderSummaryToggle"\)[\s\S]*?)<\/script>/)?.[1] ?? "";
    const mount = (wide: boolean, url = "/cart") => {
      window.history.replaceState(null, "", url);
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => ({ matches: wide, addEventListener: () => undefined }),
      });
      document.body.innerHTML = `
        <div id="cartPageRoot" data-summary="closed">
          <div data-cart-grid>
            <div id="cartColumn"><button id="orderSummaryToggle" aria-expanded="false"></button></div>
            <div id="checkoutPanel"><button id="submitButton"></button></div>
          </div>
        </div>`;
      new Function(layoutScript)();
      const grid = document.querySelector("[data-cart-grid]")!;
      return {
        order: [...grid.children].map((child) => child.id),
        summary: document.getElementById("cartPageRoot")!.dataset.summary,
        expanded: document.getElementById("orderSummaryToggle")!.getAttribute("aria-expanded"),
      };
    };
    afterEach(() => window.history.replaceState(null, "", "/"));

    it("puts the cart before the form on phones and after it on wide screens, in the DOM itself", () => {
      expect(layoutScript).not.toBe("");
      expect(mount(false).order).toEqual(["cartColumn", "checkoutPanel"]);
      expect(mount(true).order).toEqual(["checkoutPanel", "cartColumn"]);
      // No CSS reordering: what is read and tabbed is what is seen (WCAG 1.3.2, 2.4.3).
      expect(cartPage).not.toMatch(/\b(lg:)?order-[12]\b/);
    });

    it("starts the phone summary folded, so the first screen is the form (Dawn's checkout)", () => {
      expect(mount(false, "/cart#checkoutFormCard")).toMatchObject({ summary: "closed", expanded: "false" });
      expect(mount(false, "/cart")).toMatchObject({ summary: "closed", expanded: "false" });
      sessionStorage.setItem("quickBuyData", "{}");
      expect(mount(false, "/cart")).toMatchObject({ summary: "closed", expanded: "false" });
    });

    it("toggles the summary before the page scripts load, and never hides an empty cart's message", () => {
      const toggle = cartPage.match(/<button\s+type="button"\s+id="orderSummaryToggle"[\s\S]*?>/)?.[0] ?? "";
      expect(toggle).toContain('aria-controls="orderSummaryBody"');
      expect(toggle).toMatch(/onclick="[^"]*dataset\.summary[^"]*aria-expanded/);
      expect(toggle).toContain("lg:hidden");
      expect(cartPage).toContain('#cartPageRoot[data-summary="closed"]:not([data-cart-state="empty"]) #orderSummaryBody { display: none; }');
      expect(cartPage).toContain('<span id="orderSummaryToggleTotal"');
    });

    it("says the total on Place order and why it is disabled in a line the button names", () => {
      const button = cartPage.slice(cartPage.indexOf('id="submitButton"'), cartPage.indexOf("</button>", cartPage.indexOf('id="submitButton"')));
      expect(button).toContain('id="submitButtonTotal"');
      expect(button).toContain('aria-describedby={checkoutUnavailable ? "submitButtonReason" : undefined}');
      expect(cartPage).toMatch(/<p id="submitButtonReason"[^>]*hidden=\{!checkoutUnavailable\}/);
    });
  });
});
