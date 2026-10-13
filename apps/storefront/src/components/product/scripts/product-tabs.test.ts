// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "./product-tabs";

function renderTabs(direction = "ltr", third = false) {
  document.body.innerHTML = `
    <button id="unrelated-tab" role="tab" aria-selected="true">Elsewhere</button>
    <div data-product-details-tabs>
      <button id="scroll-left" disabled>Previous tabs</button>
      <button id="scroll-right" disabled>More tabs</button>
      <nav id="tab-nav" role="tablist" style="direction:${direction}">
        <button id="details-tab-description" role="tab" data-tab-id="description" data-tab-anchor="details-panel-description" aria-selected="true" tabindex="0">Description</button>
        <button id="details-tab-review" role="tab" data-tab-id="review" data-tab-anchor="details-panel-review" aria-selected="false" tabindex="-1">Review</button>
        ${third ? '<button id="details-tab-delivery" role="tab" data-tab-id="delivery" data-tab-anchor="details-panel-delivery" aria-selected="false" tabindex="-1">Delivery</button>' : ""}
      </nav>
      ${third ? '<div id="details-panel-delivery" role="tabpanel" data-tab-panel="delivery" class="hidden">Delivery</div>' : ""}
      <div id="fade-left"></div>
      <div id="fade-right"></div>
      <div id="details-panel-description" role="tabpanel" data-tab-panel="description">Description panel</div>
      <div id="details-panel-review" role="tabpanel" data-tab-panel="review" class="hidden">Review panel</div>
    </div>
  `;
  const nav = document.querySelector<HTMLElement>("#tab-nav")!;
  Object.defineProperties(nav, { scrollWidth: { value: 900 }, clientWidth: { value: 300 } });
  init();
  nav.dispatchEvent(new Event("scroll"));
}

beforeEach(() => {
  window.history.replaceState({}, "", "/products/example");
  document.body.innerHTML = "";
  vi.spyOn(HTMLElement.prototype, "scrollBy").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    () => undefined,
  );
});

describe("product detail tabs", () => {
  it("switches only the product tabs and keeps URL anchor state in sync", () => {
    renderTabs();

    const review = document.querySelector<HTMLButtonElement>(
      "#details-tab-review",
    )!;
    review.click();

    expect(review.getAttribute("aria-selected")).toBe("true");
    expect(review.tabIndex).toBe(0);
    expect(document.querySelector("#details-tab-description")?.getAttribute("aria-selected")).toBe("false");
    expect(document.querySelector("#details-panel-review")?.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#details-panel-description")?.classList.contains("hidden")).toBe(true);
    expect(window.location.hash).toBe("#details-panel-review");
    expect(document.querySelector("#unrelated-tab")?.getAttribute("aria-selected")).toBe("true");
  });

  it("opens a directly linked tab and supports Home/End keyboard navigation", () => {
    window.history.replaceState({}, "", "/products/example#details-panel-review");
    renderTabs();

    const description = document.querySelector<HTMLButtonElement>(
      "#details-tab-description",
    )!;
    const review = document.querySelector<HTMLButtonElement>(
      "#details-tab-review",
    )!;

    expect(review.getAttribute("aria-selected")).toBe("true");
    review.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(description.getAttribute("aria-selected")).toBe("true");
    expect(window.location.hash).toBe("#details-panel-description");

    description.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(review.getAttribute("aria-selected")).toBe("true");
  });
});

afterEach(() => vi.restoreAllMocks());

describe.each(["ltr", "rtl"])("detail tab scrolling in %s", (direction) => {
  it("enables only arrows with room and scrolls toward the logical next edge", () => {
    renderTabs(direction, true);
    const nav = document.querySelector<HTMLElement>("#tab-nav")!;
    const previous = document.querySelector<HTMLButtonElement>("#scroll-left")!;
    const more = document.querySelector<HTMLButtonElement>("#scroll-right")!;
    expect(previous.disabled).toBe(true);
    expect(more.disabled).toBe(false);
    vi.mocked(nav.scrollBy).mockClear();
    more.click();
    expect(nav.scrollBy).toHaveBeenCalledWith({ left: direction === "rtl" ? -200 : 200, behavior: "smooth" });
    nav.scrollLeft = direction === "rtl" ? -300 : 300;
    nav.dispatchEvent(new Event("scroll"));
    expect(previous.disabled).toBe(false);
    expect(more.disabled).toBe(false);
    previous.click();
    expect(nav.scrollBy).toHaveBeenLastCalledWith({ left: direction === "rtl" ? 200 : -200, behavior: "smooth" });
    more.focus();
    nav.scrollLeft = direction === "rtl" ? -600 : 600;
    nav.dispatchEvent(new Event("scroll"));
    expect(previous.disabled).toBe(false);
    expect(more.disabled).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[role="tab"][aria-selected="true"][data-tab-id]'));
  });

  it("centers with physical geometry and follows visual keyboard direction", () => {
    renderTabs(direction, true);
    const nav = document.querySelector<HTMLElement>("#tab-nav")!;
    const description = document.querySelector<HTMLButtonElement>("#details-tab-description")!;
    const review = document.querySelector<HTMLButtonElement>("#details-tab-review")!;
    vi.spyOn(nav, "getBoundingClientRect").mockReturnValue({ left: 100, width: 300 } as DOMRect);
    vi.spyOn(review, "getBoundingClientRect").mockReturnValue({ left: direction === "rtl" ? -50 : 500, width: 100 } as DOMRect);
    description.dispatchEvent(new KeyboardEvent("keydown", { key: direction === "rtl" ? "ArrowLeft" : "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(review);
    expect(review.getAttribute("aria-selected")).toBe("true");
    expect(nav.scrollBy).toHaveBeenLastCalledWith({ left: direction === "rtl" ? -250 : 300, behavior: "smooth" });
    expect(window.location.hash).toBe("#details-panel-review");
    expect(review.scrollIntoView).not.toHaveBeenCalled();
  });
});
