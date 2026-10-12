// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import landingBar from "./landing-bar";

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 1));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0, writable: true });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mount(id = "one", ready = true) {
  document.body.insertAdjacentHTML("beforeend", `<section class="noor-s-order" id="order-${id}">
    ${ready ? '<form data-order-form></form>' : ""}
    <scalius-island class="noor-bar"><a href="#order-${id}">Order now</a></scalius-island></section>`);
  const order = document.getElementById(`order-${id}`)!;
  const bounds = { top: window.innerHeight * 2, bottom: window.innerHeight * 3 };
  order.getBoundingClientRect = () => bounds as DOMRect;
  const bar = order.querySelector<HTMLElement>("scalius-island")!;
  const cleanup = landingBar.mount(bar, { target: order.id }, {} as never);
  if (cleanup) cleanups.push(cleanup);
  return { bar, bounds };
}

function scroll() {
  window.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(1);
}

it("removes hidden order controls from keyboard and accessibility navigation", () => {
  const { bar, bounds } = mount();
  expect(bar.inert).toBe(true);
  expect(bar.getAttribute("aria-hidden")).toBe("true");
  Object.assign(window, { scrollY: window.innerHeight });
  scroll();
  expect(bar.inert).toBe(false);
  expect(bar.hasAttribute("data-hidden")).toBe(false);
  bounds.top = 0;
  scroll();
  expect(bar.inert).toBe(true);
  expect(bar.hasAttribute("data-hidden")).toBe(true);
});

it("does not show a bar when the core order form is unavailable", () => {
  Object.assign(window, { scrollY: window.innerHeight });
  const { bar } = mount("one", false);
  expect(bar.inert).toBe(true);
  expect(bar.hasAttribute("data-hidden")).toBe(true);
});

it("shows at most one bar and keeps it linked to the next usable form", () => {
  Object.assign(window, { scrollY: window.innerHeight });
  const first = mount("one");
  const second = mount("two");
  scroll();
  expect(first.bar.inert).toBe(false);
  expect(second.bar.inert).toBe(true);
  first.bounds.top = 0;
  scroll();
  expect(first.bar.inert).toBe(true);
  expect(second.bar.inert).toBe(true);
  first.bounds.bottom = -1;
  scroll();
  expect(first.bar.inert).toBe(true);
  expect(second.bar.inert).toBe(false);
  expect(second.bar.querySelector("a")!.getAttribute("href")).toBe("#order-two");
});
