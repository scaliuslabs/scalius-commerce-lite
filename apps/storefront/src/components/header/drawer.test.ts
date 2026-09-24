// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDrawer } from "./drawer";

let cleanup: () => void = () => undefined;

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    run(0);
    return 0;
  });
  document.body.innerHTML = `
    <div class="site-wrapper">
      <header id="site-header">
        <button id="toggle" type="button">Menu</button>
        <div id="overlay" class="invisible opacity-0 pointer-events-none"></div>
        <div id="panel" class="invisible -translate-x-full" role="dialog">
          <button id="close" type="button">Close</button>
          <a id="first-link" href="/women">Women</a>
          <a id="last-link" href="/men">Men</a>
        </div>
      </header>
      <main id="main"><a href="/x">Page link</a></main>
    </div>
    <footer id="footer"></footer>`;
  const element = (id: string) => document.getElementById(id)!;
  // happy-dom has no layout: count every element as rendered.
  for (const id of ["close", "first-link", "last-link"]) {
    Object.defineProperty(element(id), "offsetParent", { configurable: true, value: element("panel") });
  }
  cleanup = installDrawer({
    panel: element("panel"),
    overlay: element("overlay"),
    closeButton: element("close"),
    openers: [element("toggle")],
    historyKey: "__testDrawer",
    phoneOnly: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const element = (id: string) => document.getElementById(id)!;
const key = (target: Element, name: string, shiftKey = false) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true }));

describe("drawer", () => {
  it("starts closed and out of reach once JavaScript owns it", () => {
    expect(element("panel").inert).toBe(true);
    expect(element("panel").getAttribute("aria-hidden")).toBe("true");
  });

  it("opens as a modal: background inert, focus inside, trapped", () => {
    element("toggle").focus();
    element("toggle").click();
    expect(element("toggle").getAttribute("aria-expanded")).toBe("true");
    expect(element("panel").inert).toBe(false);
    expect(element("panel").classList.contains("invisible")).toBe(false);
    expect(element("main").inert).toBe(true);
    expect(element("footer").inert).toBe(true);
    expect(element("toggle").inert).toBe(true);
    expect(document.activeElement).toBe(element("close"));
    element("last-link").focus();
    key(element("last-link"), "Tab");
    expect(document.activeElement).toBe(element("close"));
    key(element("close"), "Tab", true);
    expect(document.activeElement).toBe(element("last-link"));
  });

  it("closes on Escape and returns focus to the opener", () => {
    element("toggle").click();
    key(element("first-link"), "Escape");
    expect(element("toggle").getAttribute("aria-expanded")).toBe("false");
    expect(element("panel").inert).toBe(true);
    expect(element("main").inert).toBe(false);
    expect(document.activeElement).toBe(element("toggle"));
  });

  it("closes from the backdrop and when a link is followed", () => {
    element("toggle").click();
    element("overlay").click();
    expect(element("panel").inert).toBe(true);
    element("toggle").click();
    element("first-link").click();
    expect(element("panel").inert).toBe(true);
  });
});
