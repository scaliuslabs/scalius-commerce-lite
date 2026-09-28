// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { revealSelectedOptions } from "./product-controller";

afterEach(() => { document.body.replaceChildren(); });

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
