// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import header from "./header";

let cleanup: void | (() => void);
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each([true, false])("preserves the server's transparent decision (%s) regardless of body markup", (transparent) => {
  document.body.innerHTML = `<div class="noor-header-shell${transparent ? " is-transparent" : ""}"><scalius-island></scalius-island></div>
    <main><section class="noor-s-products">Products</section><section class="noor-s-hero"><img src="/hero.jpg"></section></main>`;
  const shell = document.querySelector<HTMLElement>(".noor-header-shell")!;
  cleanup = header.mount(shell.querySelector<HTMLElement>("scalius-island")!, undefined, {} as never);
  expect(shell.classList.contains("is-transparent")).toBe(transparent);
  expect(shell.hasAttribute("data-overlay-ready")).toBe(false);
  cleanup?.();
  cleanup = undefined;
  expect(shell.classList.contains("is-transparent")).toBe(transparent);
});

it("only enables the visible announcement and pauses while the buyer uses its link", () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.body.innerHTML = `<div class="noor-header-shell"><scalius-island>
    <ul data-announce-list><li data-active><a href="/first">First</a></li><li inert aria-hidden="true"><a href="/second">Second</a></li></ul>
  </scalius-island></div>`;
  const element = document.querySelector<HTMLElement>("scalius-island")!;
  cleanup = header.mount(element, undefined, {} as never);
  const [first, second] = element.querySelectorAll<HTMLElement>("li");
  vi.advanceTimersByTime(5000);
  expect(first!.inert).toBe(true);
  expect(first!.hasAttribute("data-active")).toBe(false);
  expect(second!.inert).toBe(false);
  expect(second!.hasAttribute("data-active")).toBe(true);
  second!.querySelector("a")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  vi.advanceTimersByTime(5000);
  expect(second!.hasAttribute("data-active")).toBe(true);
});
