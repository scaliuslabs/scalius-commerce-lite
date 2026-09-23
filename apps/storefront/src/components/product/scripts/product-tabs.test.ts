// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "./product-tabs";

function renderTabs() {
  document.body.innerHTML = `
    <button id="unrelated-tab" role="tab" aria-selected="true">Elsewhere</button>
    <div data-product-details-tabs>
      <nav id="tab-nav" role="tablist">
        <button id="details-tab-description" role="tab" data-tab-id="description" data-tab-anchor="details-panel-description" aria-selected="true" tabindex="0">Description</button>
        <button id="details-tab-review" role="tab" data-tab-id="review" data-tab-anchor="details-panel-review" aria-selected="false" tabindex="-1">Review</button>
      </nav>
      <div id="fade-left"></div>
      <div id="fade-right"></div>
      <div id="details-panel-description" role="tabpanel" data-tab-panel="description">Description panel</div>
      <div id="details-panel-review" role="tabpanel" data-tab-panel="review" class="hidden">Review panel</div>
    </div>
  `;
  init();
}

beforeEach(() => {
  window.history.replaceState({}, "", "/products/example");
  document.body.innerHTML = "";
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => undefined);
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
    expect(review.classList.contains("hover:border-gray-300")).toBe(false);
    expect(review.classList.contains("hover:text-gray-700")).toBe(false);
    expect(
      document
        .querySelector("#details-tab-description")
        ?.classList.contains("hover:border-gray-300"),
    ).toBe(true);
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
