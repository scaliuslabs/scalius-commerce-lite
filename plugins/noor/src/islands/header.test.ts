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

it("makes the phone drawer modal: focus moves in, Tab stays inside, focus returns to the opener", () => {
  document.body.innerHTML = `<div class="noor-header-shell"><scalius-island><button id="opener">Menu</button></scalius-island>
    <div id="noor-drawer" popover="auto"><button id="close">Close</button>
      <ul><li><details><summary id="home">Home</summary><ul><li><a id="hidden" href="/throws">Throws</a></li></ul></details></li>
      <li><a id="last" href="/kitchen">Kitchen</a></li></ul></div></div>
    <a id="behind" href="/cart">Cart</a>`;
  const element = document.querySelector<HTMLElement>("scalius-island")!;
  cleanup = header.mount(element, undefined, {} as never);
  const drawer = document.getElementById("noor-drawer")!;
  document.getElementById("opener")!.focus();
  const toggle = (type: string, newState: string) => {
    const event = new Event(type);
    Object.defineProperty(event, "newState", { value: newState });
    drawer.dispatchEvent(event);
  };
  toggle("beforetoggle", "open");
  toggle("toggle", "open");
  expect(document.activeElement?.id).toBe("close");
  // Tab from the last reachable control wraps to the first; the closed sub-menu's link is skipped.
  document.getElementById("last")!.focus();
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement?.id).toBe("close");
  const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(back);
  expect(document.activeElement?.id).toBe("last");
  toggle("toggle", "closed");
  expect(document.activeElement?.id).toBe("opener");
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
