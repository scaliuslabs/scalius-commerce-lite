// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import slideshow from "./slideshow";

let cleanup: void | (() => void);
let motion: MediaQueryList;

beforeEach(() => {
  vi.useFakeTimers();
  motion = Object.assign(new EventTarget(), { matches: false }) as MediaQueryList;
  vi.stubGlobal("matchMedia", () => motion);
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mount(rtl = false, autoplay = true) {
  document.body.innerHTML = `<div id="slideshow">
    <ul data-track style="direction:${rtl ? "rtl" : "ltr"}"><li data-slide></li><li data-slide></li><li data-slide></li></ul>
    <div data-controls hidden><button data-prev></button><button data-next></button>
      <button data-autoplay-toggle data-play-label="Play slideshow" data-pause-label="Pause slideshow"><span data-pause-icon></span><span data-play-icon hidden></span></button>
    </div></div>`;
  const element = document.querySelector<HTMLElement>("#slideshow")!;
  const track = element.querySelector<HTMLElement>("[data-track]")!;
  [...track.children].forEach((slide, index) => Object.defineProperty(slide, "offsetLeft", { value: index * (rtl ? -300 : 300) }));
  const scroll = vi.fn();
  track.scrollTo = scroll;
  cleanup = slideshow.mount(element, { autoplay, interval: 3 }, {} as never);
  return { element, track, scroll, toggle: element.querySelector<HTMLButtonElement>("[data-autoplay-toggle]")! };
}

it.each(["pointerdown", "wheel", "keydown"])("does not resume autoplay after intentional %s input", (type) => {
  const { element, scroll, toggle } = mount();
  vi.advanceTimersByTime(3000);
  expect(scroll).toHaveBeenCalledTimes(1);
  element.dispatchEvent(new Event(type, { bubbles: true }));
  element.dispatchEvent(new Event("pointerleave"));
  element.dispatchEvent(new FocusEvent("focusout"));
  vi.advanceTimersByTime(9000);
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(toggle.getAttribute("aria-label")).toBe("Play slideshow");
});

it("lets the buyer pause and explicitly restart autoplay", () => {
  const { toggle, scroll } = mount();
  toggle.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  toggle.click();
  vi.advanceTimersByTime(6000);
  expect(scroll).not.toHaveBeenCalled();
  expect(toggle.getAttribute("aria-label")).toBe("Play slideshow");
  toggle.click();
  vi.advanceTimersByTime(3000);
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(toggle.getAttribute("aria-label")).toBe("Pause slideshow");
});

it("also stops rotation when assistive technology activates a slide control", () => {
  const { element, scroll } = mount();
  element.querySelector<HTMLButtonElement>("[data-next]")!.click();
  vi.advanceTimersByTime(6000);
  expect(scroll).toHaveBeenCalledTimes(1);
});

it("does not resume while focus remains inside after the pointer leaves", () => {
  const { element, scroll } = mount();
  element.dispatchEvent(new Event("pointerenter"));
  element.dispatchEvent(new FocusEvent("focusin"));
  element.dispatchEvent(new Event("pointerleave"));
  vi.advanceTimersByTime(3000);
  expect(scroll).not.toHaveBeenCalled();
  element.dispatchEvent(new FocusEvent("focusout"));
  vi.advanceTimersByTime(3000);
  expect(scroll).toHaveBeenCalledTimes(1);
});

it.each([[false, 300], [true, -600]])("mirrors ArrowRight in RTL (%s)", (rtl, left) => {
  const { track, scroll } = mount(rtl, false);
  track.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  expect(scroll).toHaveBeenCalledWith({ left, behavior: "smooth" });
});

it("respects reduced motion initially and when the preference changes", () => {
  Object.assign(motion, { matches: true });
  const { element, scroll, toggle } = mount();
  vi.advanceTimersByTime(3000);
  expect(scroll).not.toHaveBeenCalled();
  expect(toggle.getAttribute("aria-label")).toBe("Play slideshow");
  element.querySelector<HTMLButtonElement>("[data-next]")!.click();
  expect(scroll).toHaveBeenCalledWith({ left: 300, behavior: "auto" });
  Object.assign(motion, { matches: false });
  toggle.click();
  vi.advanceTimersByTime(3000);
  expect(scroll).toHaveBeenCalledTimes(2);
  Object.assign(motion, { matches: true });
  motion.dispatchEvent(new Event("change"));
  vi.advanceTimersByTime(3000);
  expect(scroll).toHaveBeenCalledTimes(2);
});

it("cleans up autoplay when the section is removed", () => {
  const { scroll } = mount();
  cleanup?.();
  cleanup = undefined;
  vi.advanceTimersByTime(6000);
  expect(scroll).not.toHaveBeenCalled();
});
