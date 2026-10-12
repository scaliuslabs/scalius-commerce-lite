// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindStorefrontChrome } from "./storefront-chrome";

let cleanup: (() => void) | undefined;
let resize: ResizeObserverCallback;
let frames: Map<number, FrameRequestCallback>;
let frameId = 0;

beforeEach(() => {
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  document.documentElement.style.removeProperty("--header-height");
  document.documentElement.style.removeProperty("--product-sticky-height");
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--header-height");
  document.documentElement.style.removeProperty("--product-sticky-height");
});

function flush() {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(0));
}

function changedSize() {
  resize([], {} as ResizeObserver);
  flush();
}

function box(element: HTMLElement, height: number, top = 0) {
  const geometry = { height, top };
  const read = vi.fn(() => geometry.height);
  Object.defineProperty(element, "offsetHeight", { configurable: true, get: read });
  return { geometry, read };
}

function header(style = "position:sticky;top:0") {
  document.body.innerHTML = `<div data-storefront-header><header data-sticky-header style="${style}"></header></div><main></main>`;
  return document.querySelector<HTMLElement>("[data-sticky-header]")!;
}

function bind() {
  cleanup = bindStorefrontChrome(document);
  flush();
}

const offset = () => document.documentElement.style.getPropertyValue("--header-height");
const productOffset = () => document.documentElement.style.getPropertyValue("--product-sticky-height");

describe("the host-owned storefront chrome contract", () => {
  it("publishes any declared header's actual height, including announcements and resize", () => {
    const element = header();
    const { geometry } = box(element, 148);
    bind();
    expect(offset()).toBe("148px");
    geometry.height = 96;
    changedSize();
    expect(offset()).toBe("96px");
  });

  it.each(["position:relative", "position:static", "position:sticky;top:0;display:none", "position:sticky;top:0;visibility:hidden"])("does not reserve a hidden or normal-flow header (%s)", (style) => {
    box(header(style), 148);
    bind();
    expect(offset()).toBe("0px");
  });

  it("reserves sticky height before the row pins, rather than its distance down the page", () => {
    box(header(), 64, 100);
    bind();
    expect(offset()).toBe("64px");
  });

  it("includes a declared top inset and does not cap a tall header's real obstruction", () => {
    box(header("position:fixed;top:12px"), 600);
    bind();
    expect(offset()).toBe("612px");
  });

  it("clears a previous sticky reservation when the header changes to normal flow", () => {
    const element = header();
    box(element, 96);
    bind();
    element.style.position = "relative";
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(offset()).toBe("0px");
  });

  it("switches from the whole header to only its sticky menu row across a breakpoint", () => {
    const parent = header();
    parent.innerHTML = '<nav data-sticky-header style="position:relative"></nav>';
    const row = parent.querySelector<HTMLElement>("nav")!;
    box(parent, 128);
    box(row, 44, 84);
    bind();
    expect(offset()).toBe("128px");
    parent.style.display = "contents";
    row.style.position = "sticky";
    row.style.top = "0px";
    changedSize();
    expect(offset()).toBe("44px");
  });

  it("does not add a nested sticky child twice", () => {
    const parent = header();
    parent.innerHTML = '<nav data-sticky-header style="position:sticky;top:0"></nav>';
    box(parent, 128);
    box(parent.querySelector<HTMLElement>("nav")!, 44);
    bind();
    expect(offset()).toBe("128px");
  });

  it("retains the layout reservation when a header slides above the viewport", () => {
    const element = header("position:sticky;top:0;transform:translateY(-100%)");
    box(element, 100, -100);
    bind();
    expect(offset()).toBe("100px");
  });

  it("keeps the same reservation through a partial slide-away", () => {
    const element = header("position:sticky;top:0;transform:translateY(-40px)");
    box(element, 100, -40);
    bind();
    expect(offset()).toBe("100px");
  });

  it("does not force layout for ordinary scrolling of an unchanged header", () => {
    const { read } = box(header(), 96);
    bind();
    read.mockClear();
    window.dispatchEvent(new Event("scroll"));
    flush();
    expect(read).not.toHaveBeenCalled();
  });

  it("tracks a visible top product bar separately and releases it when hidden", () => {
    box(header(), 96);
    const bar = document.createElement("nav");
    bar.setAttribute("data-product-topbar", "");
    bar.style.cssText = "position:fixed;top:96px";
    document.querySelector("main")!.appendChild(bar);
    box(bar, 52, 96);
    bind();
    expect(offset()).toBe("96px");
    expect(productOffset()).toBe("52px");
    bar.style.visibility = "hidden";
    changedSize();
    expect(productOffset()).toBe("0px");
  });

  it("reserves the desktop buy bar before deep-link scrolling makes it visible", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    box(header(), 134);
    const bar = document.createElement("div");
    bar.setAttribute("data-product-topbar", "desktop");
    bar.style.cssText = "position:fixed;top:134px;visibility:hidden";
    document.querySelector("main")!.appendChild(bar);
    box(bar, 65, 134);
    bind();
    expect(productOffset()).toBe("65px");
    bar.style.visibility = "visible";
    changedSize();
    expect(productOffset()).toBe("65px");
    bar.style.display = "none";
    changedSize();
    expect(productOffset()).toBe("0px");
  });

  it("ignores a phone's bottom buy bar even when computed top is a used pixel value", () => {
    const media = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    box(header(), 96);
    const bar = document.createElement("div");
    bar.setAttribute("data-product-topbar", "desktop");
    bar.style.cssText = "position:fixed;top:783px;bottom:0";
    document.querySelector("main")!.appendChild(bar);
    box(bar, 61, 783);
    const nav = document.createElement("nav");
    nav.setAttribute("data-product-topbar", "");
    nav.style.cssText = "position:sticky;top:96px";
    document.querySelector("main")!.appendChild(nav);
    box(nav, 52, 96);
    bind();
    expect(productOffset()).toBe("52px");
    media.mockReturnValue({ matches: true } as MediaQueryList);
    bar.style.top = "96px";
    nav.style.display = "none";
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(productOffset()).toBe("61px");
  });

  it("clears state on unmount so replacing an app header cannot leave its old offset", () => {
    box(header(), 148);
    bind();
    cleanup?.();
    cleanup = undefined;
    expect(offset()).toBe("0px");
    expect(productOffset()).toBe("0px");
  });
});
