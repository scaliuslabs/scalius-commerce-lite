// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableIframePageLoading": true } }
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";
import { SectionLibraryPreview, type LibraryPreviewContext } from "./SectionLibraryPreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const preview: LibraryPreviewContext = { origin: "https://shop.test", ready: true, path: "/", revision: 4, retry: vi.fn() };
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setLocale("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
function render(selection = "faq", context = preview) {
  act(() => root.render(<SectionLibraryPreview selection={selection} name={selection} preview={context} />));
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const frame = () => host.querySelector("iframe")!;
function message(state: string, overrides: MessageEventInit = {}) {
  const v = new URL(frame().src).searchParams.get("v");
  act(() => window.dispatchEvent(new MessageEvent("message", {
    origin: preview.origin!, source: frame().contentWindow,
    data: { type: "scalius:library-preview", v, state }, ...overrides,
  })));
}

describe("one selected library document", () => {
  it("debounces rapid selection to one nonsecret navigation and unmounts the previous document", () => {
    render("hero"); advance(100); render("banner"); advance(100); render("faq"); advance(149);
    expect(frame()).toBeNull(); advance(1);
    const first = frame();
    expect(new URL(first.src).searchParams.get("section")).toBe("faq");
    expect(first.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(first.src).not.toMatch(/token|cookie|draft/);
    render("editorial"); expect(frame()).toBeNull(); advance(150);
    expect(frame()).not.toBe(first);
    expect(host.querySelectorAll("iframe")).toHaveLength(1);
  });
  it("accepts only the current document's source, origin and nonce", () => {
    render(); advance(150);
    message("ready", { origin: "https://evil.test" });
    message("ready", { source: window });
    message("ready", { data: { type: "scalius:library-preview", state: "ready", v: "old-document" } });
    expect(host.textContent).toContain("Loading preview");
    message("ready"); expect(host.textContent).not.toContain("Loading preview"); advance(16000);
    expect(host.textContent).not.toContain("couldn't load");
  });
  it("keeps truthful empty state and offers retry after a failed document", () => {
    render(); advance(150); message("empty"); expect(host.textContent).toContain("needs content");
    render("hero"); advance(150); advance(15000); expect(host.textContent).toContain("couldn't load");
    act(() => host.querySelector("button")!.click());
    expect(preview.retry).toHaveBeenCalledTimes(1); advance(150);
    expect(frame()).not.toBeNull();
  });
  it("reports an authenticated renderer failure without waiting for a timeout", () => {
    render(); advance(150); message("failed");
    expect(host.textContent).toContain("couldn't load");
    expect(host.textContent).not.toContain("needs content");
    expect(frame()).toBeNull();
  });
  it("does not frame before authentication or on the dashboard's own origin", () => {
    render("faq", { ...preview, ready: false }); advance(1000); expect(frame()).toBeNull();
    render("faq", { ...preview, origin: window.location.origin }); advance(1000); expect(frame()).toBeNull();
    expect(host.textContent).toContain("Connect the storefront");
  });
});
