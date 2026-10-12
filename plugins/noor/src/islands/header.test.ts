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

it.each([
  [".noor-s-hero overlay", '<section class="noor-s-hero"><div class="noor-hero is-overlay"><div class="noor-hero-media"><img src="/hero.jpg"></div></div></section>', true],
  ["slideshow overlay", '<section class="noor-s-slideshow"><scalius-island><div class="noor-hero is-overlay"><div class="noor-hero-media"><img src="/hero.jpg"></div></div></scalius-island></section>', true],
  ["product grid before hero", '<section class="noor-s-products">Products</section><section class="noor-s-hero"><div class="noor-hero is-overlay"><div class="noor-hero-media"><img src="/hero.jpg"></div></div></section>', false],
  ["split hero", '<section class="noor-s-hero"><div class="noor-hero is-split"><div class="noor-hero-media"><img src="/hero.jpg"></div></div></section>', false],
  ["hero without media", '<section class="noor-s-hero"><div class="noor-hero is-overlay"><div class="noor-hero-media"></div></div></section>', false],
])("only enables header overlap over a leading photo overlay: %s", (_, markup, eligible) => {
  document.body.innerHTML = `<div class="contents"><div class="noor-header-shell is-transparent"><scalius-island></scalius-island></div></div>
    <main id="main-content"><h1 class="sr-only">Store</h1><div><div data-home-render-unit data-home-section="app"><div class="contents" data-sx-app="scalius.noor">${markup}</div></div></div></main>`;
  const shell = document.querySelector<HTMLElement>(".noor-header-shell")!;
  expect(shell.hasAttribute("data-overlay-ready")).toBe(false);
  cleanup = header.mount(shell.querySelector<HTMLElement>("scalius-island")!, undefined, {} as never);
  expect(shell.hasAttribute("data-overlay-ready")).toBe(eligible);
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
