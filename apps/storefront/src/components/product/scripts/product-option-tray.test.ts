// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { init, revealSelectedOptions } from "./product-controller";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("keeps a linked choice visible inside a long option tray without moving the page", () => {
  document.body.innerHTML = '<div class="variant-option-values" data-option-overflow><button class="variant-option-btn" aria-pressed="true">128 GB</button></div>';
  const tray = document.querySelector<HTMLElement>(".variant-option-values")!;
  const selected = tray.querySelector<HTMLElement>("button")!;
  tray.getBoundingClientRect = () => ({ top: 100, bottom: 300 } as DOMRect);
  selected.getBoundingClientRect = () => ({ top: 340, bottom: 380 } as DOMRect);

  revealSelectedOptions();
  expect(tray.scrollTop).toBe(80);
  expect(window.scrollY).toBe(0);

  selected.getBoundingClientRect = () => ({ top: 80, bottom: 120 } as DOMRect);
  revealSelectedOptions();
  expect(tray.scrollTop).toBe(60);
});

it("updates exact SKU tile prices when another merchant option changes", () => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => callback(0));
  const options = [
    { id: "plan", name: "Plan", values: [{ id: "basic" }, { id: "pro" }] },
    { id: "term", name: "Term", values: [{ id: "monthly" }, { id: "yearly" }] },
  ];
  const variants = [
    ["basic", "monthly", 100], ["pro", "monthly", 100],
    ["basic", "yearly", 90], ["pro", "yearly", 120],
  ].map(([plan, term, price]) => ({
    id: `${plan}-${term}`,
    selectedOptions: [
      { optionDefinitionId: "plan", optionValueId: plan },
      { optionDefinitionId: "term", optionValueId: term },
    ],
    price,
    discountedPrice: price,
    stock: 1,
    reservedStock: 0,
    trackInventory: true,
  }));
  document.body.innerHTML = `
    <div id="product-container" data-product-original-price="100" data-currency-decimal-places="2"></div>
    <script type="application/json" id="product-options-data">${JSON.stringify(options)}</script>
    <script type="application/json" id="product-variants-data">${JSON.stringify(variants)}</script>
    <div id="product-actions"></div>
    <div class="variant-option-panels">${options.map((option) => `
      <fieldset data-option-definition-id="${option.id}">
        ${option.values.map((value) => `<button type="button" class="variant-option-btn"
          data-option-definition-id="${option.id}" data-option-value-id="${value.id}"
          data-option-value="${value.id}"><span data-option-price hidden></span></button>`).join("")}
      </fieldset>`).join("")}</div>`;
  init();
  const tile = (axis: string, value: string) => document.querySelector<HTMLButtonElement>(
    `.variant-option-btn[data-option-definition-id="${axis}"][data-option-value-id="${value}"]`,
  )!;
  // Values priced the same show no price; once they differ, each shows its own.
  expect(tile("plan", "pro").querySelector("[data-option-price]")?.textContent).toBe("");
  tile("term", "yearly").click();
  expect(tile("plan", "pro").querySelector("[data-option-price]")?.textContent).toBe("৳120");
  expect(tile("plan", "pro").getAttribute("aria-label")).toBe("Plan: pro ৳120.");
});
