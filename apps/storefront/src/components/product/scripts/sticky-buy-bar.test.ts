// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindStickyBuyBar } from "./sticky-buy-bar";

let observed: IntersectionObserverCallback;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observed = callback; }
    observe() {}
    disconnect() {}
  });
  document.body.innerHTML = `
    <p class="product-price">৳3,790</p>
    <div id="product-actions">
      <button type="button" data-action="add-to-cart"><span data-action-label="add-to-cart">Add to Cart</span></button>
    </div>
    <div data-sticky-buy class="invisible translate-y-full" inert>
      <p data-sticky-buy-price></p>
      <button type="button" data-sticky-buy-action>Add to cart</button>
    </div>`;
});

const bar = () => document.querySelector<HTMLElement>("[data-sticky-buy]")!;
const scrolledPast = (past: boolean) =>
  observed([{ isIntersecting: !past, boundingClientRect: { bottom: past ? -10 : 400 } } as IntersectionObserverEntry], {} as IntersectionObserver);

describe("phone buy bar", () => {
  it("appears only after the buy buttons scroll above the viewport", () => {
    bindStickyBuyBar(bar(), document);
    expect(bar().inert).toBe(true);
    scrolledPast(true);
    expect(bar().classList.contains("invisible")).toBe(false);
    expect(bar().inert).toBe(false);
    scrolledPast(false);
    expect(bar().inert).toBe(true);
  });

  it("reserves room below the page only while it shows, so the footer stays reachable", () => {
    const root = document.documentElement;
    bindStickyBuyBar(bar(), document);
    expect(root.hasAttribute("data-sticky-buy-visible")).toBe(false);
    scrolledPast(true);
    expect(root.hasAttribute("data-sticky-buy-visible")).toBe(true);
    scrolledPast(false);
    expect(root.hasAttribute("data-sticky-buy-visible")).toBe(false);
    scrolledPast(true);
    // Rebinding (a new page) drops the reservation along with the bar.
    bindStickyBuyBar(bar(), document);
    expect(root.hasAttribute("data-sticky-buy-visible")).toBe(false);
  });

  it("mirrors the price and label and presses the real Add to cart", async () => {
    const main = document.querySelector<HTMLButtonElement>('[data-action="add-to-cart"]')!;
    const clicks = vi.fn();
    main.addEventListener("click", clicks);
    bindStickyBuyBar(bar(), document);
    const action = bar().querySelector<HTMLButtonElement>("[data-sticky-buy-action]")!;
    expect(bar().querySelector("[data-sticky-buy-price]")?.textContent).toBe("৳3,790");
    expect(action.textContent).toBe("Add to Cart");

    action.click();
    expect(clicks).toHaveBeenCalledTimes(1);

    main.disabled = true;
    main.querySelector("span")!.textContent = "Sold out";
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(action.disabled).toBe(true);
    expect(action.textContent).toBe("Sold out");
  });
});
