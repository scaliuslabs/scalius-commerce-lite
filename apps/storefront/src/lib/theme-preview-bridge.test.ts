// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { themePreviewBridgeScript } from "./theme-preview-bridge";

const DASHBOARD = "https://admin.shop.test";
const PAGE = `
  <style data-theme-tokens>:root{--color-primary:#000}</style>
  <style data-theme-fonts></style>
  <div class="flex flex-col" data-theme-region="page">
    <div class="contents home-render-unit" data-home-render-unit data-theme-section-id="story">
      <section><h2>Our story</h2><a href="/about">Read more</a></section>
    </div>
    <div class="contents home-render-unit" data-home-render-unit data-theme-section-id="faq">
      <section><h2>Questions</h2></section>
    </div>
    <div class="contents home-render-unit" data-home-render-unit data-theme-section-id="seo">
      <section><h2>About us</h2></section>
    </div>
  </div>`;

interface Harness {
  window: Window;
  parent: { postMessage: ReturnType<typeof vi.fn> };
  fetch: ReturnType<typeof vi.fn>;
  /** A message as the browser delivers it, from the parent at the dashboard origin unless told otherwise. */
  deliver(data: unknown, from?: { origin?: string; source?: unknown }): void;
  /** Every message the page posted to its parent, with the origin it addressed. */
  posted(): Array<[Record<string, unknown>, string]>;
  /** The posted messages of one type. */
  of(type: string): Array<Record<string, unknown>>;
  /** The page's unit ids in document order, with hidden ones left out. */
  shown(): Array<string | null>;
}

const windows: Window[] = [];
afterEach(async () => {
  for (const each of windows.splice(0)) await each.happyDOM.close();
});

function start(dashboard = DASHBOARD): Harness {
  const window = new Window({ url: "https://shop.test/", settings: { enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  windows.push(window);
  window.document.body.innerHTML = PAGE;
  window.document.body.setAttribute("data-theme-density", "roomy");
  window.document.body.setAttribute("data-card-style", "outlined");
  const parent = { postMessage: vi.fn() };
  const fetch = vi.fn();
  Object.defineProperty(window, "parent", { configurable: true, value: parent });
  Object.defineProperty(window, "fetch", { configurable: true, value: fetch });
  const script = window.document.createElement("script");
  script.textContent = themePreviewBridgeScript(dashboard);
  window.document.body.append(script);
  const posted = () => parent.postMessage.mock.calls as Array<[Record<string, unknown>, string]>;
  return {
    window,
    parent,
    fetch,
    deliver(data, from = {}) {
      const event = new window.MessageEvent("message", { data, origin: from.origin ?? DASHBOARD });
      Object.defineProperty(event, "source", { value: "source" in from ? from.source : parent });
      window.dispatchEvent(event);
    },
    posted,
    of: (type) => posted().map(([message]) => message).filter((message) => message.type === type),
    shown: () =>
      Array.from(window.document.querySelectorAll("[data-home-render-unit]"))
        .filter((unit) => !unit.hasAttribute("hidden"))
        .map((unit) => unit.getAttribute("data-theme-section-id")),
  };
}

const EDITOR = "scalius-theme-editor";
const connect = (harness: Harness, inspector = true) =>
  harness.deliver({ source: EDITOR, type: "connect", inspector, scrollY: null });

const html = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/html" } });
const UNIT = (id: string, text: string) =>
  `<div class="contents home-render-unit" data-home-render-unit data-theme-section-id="${id}"><section><h2>${text}</h2></section></div>`;

const click = (harness: Harness, target: Element) => {
  const event = new harness.window.MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

describe("the storefront preview bridge", () => {
  it("is nothing without a dashboard origin", () => {
    expect(themePreviewBridgeScript("")).toBe("");
  });

  it("says hello to the dashboard origin only, and starts only when the dashboard answers", () => {
    const harness = start();
    expect(harness.posted()).toEqual([[{ source: "scalius-theme-preview", type: "hello", path: "/" }, DASHBOARD]]);
    // The same answer from another origin, another window or another sender does nothing.
    const answer = { source: EDITOR, type: "connect", inspector: true, scrollY: null };
    harness.deliver(answer, { origin: "https://evil.test" });
    harness.deliver(answer, { origin: "https://admin.shop.test.evil.test" });
    harness.deliver(answer, { source: {} });
    harness.deliver({ ...answer, source: "elsewhere" });
    expect(harness.posted()).toHaveLength(1);
    // Edits before the editor connected change nothing.
    harness.deliver({ source: EDITOR, type: "text", id: "story", from: "Our story", to: "Changed" });
    expect(harness.window.document.body.textContent).toContain("Our story");
    connect(harness);
    expect(harness.of("ready")).toEqual([{ source: "scalius-theme-preview", type: "ready", path: "/", marks: ["story", "faq", "seo"] }]);
    expect(harness.posted().every(([, origin]) => origin === DASHBOARD)).toBe(true);
  });

  it("reports where each marked part is, once connected", async () => {
    const harness = start();
    const boxes: Record<string, { left: number; top: number; width: number; height: number }> = {
      story: { left: 0, top: 0, width: 800, height: 300 },
      faq: { left: 0, top: 300, width: 800, height: 200 },
    };
    Object.defineProperty(harness.window.HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Element) {
        const box = boxes[this.getAttribute("data-theme-section-id") ?? ""] ?? { left: 0, top: 0, width: 0, height: 0 };
        return { ...box, right: box.left + box.width, bottom: box.top + box.height };
      },
    });
    connect(harness);
    await vi.waitFor(() => expect(harness.of("layout")).toHaveLength(1));
    // A part that takes no space (seo) is not reported.
    expect(harness.of("layout")[0]).toMatchObject({
      rects: { story: [0, 0, 800, 300], faq: [0, 300, 800, 200] },
      scrollY: 0,
    });
  });

  it("selects and hovers only with the inspector on, and then leaves links inside sections in place", () => {
    const harness = start();
    const link = harness.window.document.querySelector("a")!;
    expect(click(harness, link).defaultPrevented).toBe(false);
    connect(harness, false);
    // Inspector off: the page behaves as buyers see it.
    expect(click(harness, link).defaultPrevented).toBe(false);
    link.dispatchEvent(new harness.window.Event("pointerover", { bubbles: true }));
    expect(harness.of("select")).toEqual([]);
    expect(harness.of("hover")).toEqual([]);

    harness.deliver({ source: EDITOR, type: "inspector", on: true });
    link.dispatchEvent(new harness.window.Event("pointerover", { bubbles: true }));
    expect(harness.of("hover")).toEqual([{ source: "scalius-theme-preview", type: "hover", id: "story" }]);
    const selected = click(harness, link);
    expect(selected.defaultPrevented).toBe(true);
    expect(harness.of("select")).toEqual([{ source: "scalius-theme-preview", type: "select", id: "story" }]);

    // Turning it off clears the hover and gives the links back.
    harness.deliver({ source: EDITOR, type: "inspector", on: false });
    expect(harness.of("hover").at(-1)).toMatchObject({ id: null });
    expect(click(harness, link).defaultPrevented).toBe(false);
    expect(harness.of("select")).toHaveLength(1);
  });

  it("forwards the editor's shortcuts, but not while typing", () => {
    const harness = start();
    connect(harness);
    const press = (target: Element, init: Record<string, unknown>) => {
      const event = new harness.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    const body = harness.window.document.body;
    expect(press(body, { key: "z", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(harness.of("key")).toEqual([{ source: "scalius-theme-preview", type: "key", key: "z", mod: true, shift: false, alt: false }]);
    // A plain letter outside the list, or typed into a field, is the page's own.
    press(body, { key: "q" });
    const field = harness.window.document.createElement("input");
    body.append(field);
    press(field, { key: "z", ctrlKey: true });
    expect(harness.of("key")).toHaveLength(1);
  });

  it("sets theme tokens as custom properties and refuses values with CSS structure", () => {
    const harness = start();
    connect(harness);
    harness.deliver({ source: EDITOR, type: "tokens", vars: { "color-primary": "#123456", "radius-card": "12px" } });
    const root = harness.window.document.documentElement.style;
    expect(root.getPropertyValue("--color-primary")).toBe("#123456");
    expect(root.getPropertyValue("--radius-card")).toBe("12px");
    expect(harness.window.document.body.style.getPropertyValue("--color-primary")).toBe("#123456");
    harness.deliver({ source: EDITOR, type: "tokens", vars: { "color-accent": "red; } body { display: none", "Bad Name": "1px" } });
    expect(root.getPropertyValue("--color-accent")).toBe("");
    expect(root.getPropertyValue("--Bad Name")).toBe("");
  });

  it("patches a section's text in place and leaves the rest alone", () => {
    const harness = start();
    connect(harness);
    harness.deliver({ source: EDITOR, type: "text", id: "story", from: "Our story", to: "Our new story" });
    const headings = Array.from(harness.window.document.querySelectorAll("h2"), (heading) => heading.textContent);
    expect(headings).toEqual(["Our new story", "Questions", "About us"]);
    // Text that only another section holds is not touched.
    harness.deliver({ source: EDITOR, type: "text", id: "story", from: "Questions", to: "Nope" });
    expect(harness.window.document.body.textContent).toContain("Questions");
  });

  it("arranges a region's units: moves them, hides the ones left out, and brings them back", () => {
    const harness = start();
    connect(harness);
    harness.deliver({ source: EDITOR, type: "arrange", region: "page", order: ["seo", "story"] });
    expect(harness.shown()).toEqual(["seo", "story"]);
    expect(harness.window.document.querySelector('[data-theme-section-id="faq"]')!.hasAttribute("hidden")).toBe(true);
    harness.deliver({ source: EDITOR, type: "arrange", region: "page", order: ["faq", "story", "seo"] });
    expect(harness.shown()).toEqual(["faq", "story", "seo"]);
    // An id the page does not hold, or a region it does not have, changes nothing.
    harness.deliver({ source: EDITOR, type: "arrange", region: "page", order: ["faq", "ghost"] });
    expect(harness.shown()).toEqual(["faq"]);
    harness.deliver({ source: EDITOR, type: "arrange", region: "after", order: [] });
    expect(harness.shown()).toEqual(["faq"]);
  });

  it("posts a section to the render route and swaps in the unit it answers", async () => {
    const harness = start();
    connect(harness);
    harness.fetch.mockResolvedValue(html(UNIT("story", "Our new story")));
    const body = { scope: { kind: "home" }, sections: [], only: "story" };
    harness.deliver({ source: EDITOR, type: "render", body, after: null });
    await vi.waitFor(() => expect(harness.window.document.body.textContent).toContain("Our new story"));
    expect(harness.fetch).toHaveBeenCalledWith("/theme-preview/render", expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store", body: JSON.stringify(body),
    }));
    expect(harness.window.document.body.textContent).not.toContain("Our story");
    expect(harness.window.document.body.textContent).toContain("Questions");
    expect(harness.shown()).toEqual(["story", "faq", "seo"]);
    expect(harness.of("render-failed")).toEqual([]);
    // The page says its marks again after a swap.
    await vi.waitFor(() => expect(harness.of("ready")).toHaveLength(2));
  });

  it("places a new section after its neighbour, and hides one the route no longer draws", async () => {
    const harness = start();
    connect(harness);
    harness.fetch.mockResolvedValueOnce(html(UNIT("fresh", "Fresh")));
    harness.deliver({ source: EDITOR, type: "render", body: { scope: { kind: "home" }, sections: [], only: "fresh" }, after: "story" });
    await vi.waitFor(() => expect(harness.shown()).toEqual(["story", "fresh", "faq", "seo"]));
    harness.fetch.mockResolvedValueOnce(html(""));
    harness.deliver({ source: EDITOR, type: "render", body: { scope: { kind: "home" }, sections: [], only: "faq" }, after: null });
    await vi.waitFor(() => expect(harness.shown()).toEqual(["story", "fresh", "seo"]));
  });

  it("swaps whole regions when the route answers regions", async () => {
    const harness = start();
    connect(harness);
    harness.fetch.mockResolvedValue(html(`<div data-theme-region="page">${UNIT("story", "Region story")}</div>`));
    harness.deliver({ source: EDITOR, type: "render", body: { scope: { kind: "home" }, sections: [] }, after: null });
    await vi.waitFor(() => expect(harness.window.document.body.textContent).toContain("Region story"));
    expect(harness.shown()).toEqual(["story"]);
    expect(harness.window.document.querySelectorAll('[data-theme-region="page"]')).toHaveLength(1);
  });

  it("tells the editor when a render failed or the session ended, and leaves the page as it was", async () => {
    const harness = start();
    connect(harness);
    const body = { scope: { kind: "home" }, sections: [], only: "story" };
    harness.fetch.mockResolvedValueOnce(html("", 500));
    harness.deliver({ source: EDITOR, type: "render", body, after: null });
    await vi.waitFor(() => expect(harness.of("render-failed")).toHaveLength(1));
    harness.fetch.mockRejectedValueOnce(new Error("offline"));
    harness.deliver({ source: EDITOR, type: "render", body, after: null });
    await vi.waitFor(() => expect(harness.of("render-failed")).toHaveLength(2));
    harness.fetch.mockResolvedValueOnce(html("", 401));
    harness.deliver({ source: EDITOR, type: "render", body, after: null });
    await vi.waitFor(() => expect(harness.of("expired")).toEqual([{ source: "scalius-theme-preview", type: "expired" }]));
    expect(harness.window.document.body.textContent).toContain("Our story");
    expect(harness.shown()).toEqual(["story", "faq", "seo"]);
  });

  it("paints the unsaved document: replaces the token and font styles and the theme attributes", async () => {
    const harness = start();
    connect(harness);
    harness.deliver({ source: EDITOR, type: "tokens", vars: { "color-primary": "#123456" } });
    expect(harness.window.document.documentElement.style.getPropertyValue("--color-primary")).toBe("#123456");
    harness.fetch.mockResolvedValue(new Response(JSON.stringify({
      css: ":root{--color-primary:#abcdef}",
      fonts: "@font-face{font-family:X}",
      attributes: { "data-theme-density": "compact", "data-card-radius": "round" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    harness.deliver({ source: EDITOR, type: "paint", theme: { version: 8 } });
    await vi.waitFor(() => expect(harness.window.document.querySelector("style[data-theme-tokens]")!.textContent).toBe(":root{--color-primary:#abcdef}"));
    expect(harness.fetch).toHaveBeenCalledWith("/theme-preview/paint", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    expect(harness.window.document.querySelector("style[data-theme-fonts]")!.textContent).toBe("@font-face{font-family:X}");
    const body = harness.window.document.body;
    expect(body.getAttribute("data-theme-density")).toBe("compact");
    expect(body.getAttribute("data-card-radius")).toBe("round");
    // An attribute the painted theme no longer sets is gone, and the instant token override is dropped for the painted block.
    expect(body.hasAttribute("data-card-style")).toBe(false);
    expect(harness.window.document.documentElement.style.getPropertyValue("--color-primary")).toBe("");
  });
});
