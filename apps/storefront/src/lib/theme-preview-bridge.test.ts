// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { Window, type Element as PageElement } from "happy-dom";
import { themePreviewBridgeScript } from "./theme-preview-bridge";

const DASHBOARD = "https://admin.shop.test";
const PAGE = `
  <style data-theme-tokens>:root{--color-primary:#000}</style>
  <style data-theme-fonts></style>
  <div class="flex flex-col" data-theme-region="page">
    <div class="contents home-render-unit" data-home-render-unit data-theme-section-id="story">
      <section><h2 data-theme-field="heading">Our story</h2><a href="/about">Read more</a></section>
    </div>
    <div class="contents home-render-unit" data-home-render-unit data-theme-section-id="faq">
      <section><h2 data-theme-field="heading">Questions</h2></section>
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

const click = (harness: Harness, target: PageElement) => {
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
    harness.deliver({ source: EDITOR, type: "text", id: "story", field: "heading", value: "Changed" });
    expect(harness.window.document.body.textContent).toContain("Our story");
    connect(harness);
    expect(harness.of("ready")).toEqual([{ source: "scalius-theme-preview", type: "ready", path: "/", marks: ["story", "faq", "seo"], fields: 1 }]);
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
    const press = (target: PageElement, init: Record<string, unknown>) => {
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
    harness.deliver({ source: EDITOR, type: "text", id: "story", field: "heading", value: "Our new story" });
    const headings = Array.from(harness.window.document.querySelectorAll("h2"), (heading) => heading.textContent);
    expect(headings).toEqual(["Our new story", "Questions", "About us"]);
    // Text that only another section holds is not touched.
    harness.deliver({ source: EDITOR, type: "text", id: "story", field: "heading", value: "Nope" });
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
    harness.deliver({ source: EDITOR, type: "render", body, after: null, seq: 7 });
    await vi.waitFor(() => expect(harness.window.document.body.textContent).toContain("Our new story"));
    expect(harness.fetch).toHaveBeenCalledWith("/theme-preview/render", expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store", body: JSON.stringify(body),
    }));
    expect(harness.window.document.body.textContent).not.toContain("Our story");
    expect(harness.window.document.body.textContent).toContain("Questions");
    expect(harness.shown()).toEqual(["story", "faq", "seo"]);
    expect(harness.of("render-failed")).toEqual([]);
    // The render is acknowledged once it landed, with the page's marks; the page does not say ready again.
    await vi.waitFor(() => expect(harness.of("ack")).toEqual([{ source: "scalius-theme-preview", type: "ack", seq: 7, marks: ["story", "faq", "seo"] }]));
    expect(harness.of("ready")).toHaveLength(1);
  });

  it("acknowledges each command once applied, a failed render too, and nothing before it connects", async () => {
    const harness = start();
    harness.deliver({ source: EDITOR, type: "tokens", vars: { "color-bg": "#ffffff" }, seq: 1 });
    expect(harness.of("ack")).toEqual([]);
    connect(harness);
    harness.deliver({ source: EDITOR, type: "tokens", vars: { "color-bg": "#ffffff" }, seq: 2 });
    harness.deliver({ source: EDITOR, type: "reveal", id: "faq", seq: 3 });
    harness.deliver({ source: EDITOR, type: "arrange", region: "page", order: ["faq", "story"], seq: 4 });
    harness.deliver({ source: EDITOR, type: "text", id: "faq", field: "heading", value: "Questions?", seq: 5 });
    harness.deliver({ source: EDITOR, type: "inspector", on: false, seq: 6 });
    expect(harness.of("ack").map((message) => message.seq)).toEqual([2, 3, 4, 5, 6]);
    harness.fetch.mockResolvedValueOnce(new Response("", { status: 500 }));
    harness.deliver({ source: EDITOR, type: "render", body: { scope: { kind: "home" }, sections: [] }, after: null, seq: 8 });
    await vi.waitFor(() => expect(harness.of("ack").at(-1)).toEqual({ source: "scalius-theme-preview", type: "ack", seq: 8, status: "failed" }));
    expect(harness.of("render-failed")).toHaveLength(1);
    harness.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ css: ":root{}", fonts: "", attributes: {} }), { headers: { "Content-Type": "application/json" } }));
    harness.deliver({ source: EDITOR, type: "paint", theme: { version: 8 }, seq: 9 });
    await vi.waitFor(() => expect(harness.of("ack").at(-1)).toMatchObject({ seq: 9 }));
  });

  it.each(["story", null])("reconciles a missing unit instead of inserting after %s", async (after) => {
    const harness = start(); connect(harness);
    harness.fetch.mockResolvedValueOnce(html(UNIT("fresh", "Fresh")));
    harness.deliver({ source: EDITOR, type: "render", body: { scope: { kind: "home" }, sections: [], only: "fresh" }, after, seq: 9, revision: 1 });
    await vi.waitFor(() => expect(harness.of("ack")).toContainEqual(expect.objectContaining({ seq: 9, status: "stale" })));
    expect(harness.shown()).toEqual(["story", "faq", "seo"]);
    expect(harness.of("render-failed")).toEqual([]);
  });

  it("reconciles banner rows when the middle becomes empty and is restored after the merge", async () => {
    const harness = start();
    const banners = (ids: string[]) => `<div data-home-render-unit>${ids.map((id) => `<section data-home-section="banner" data-theme-section-id="${id}">${id}</section>`).join("")}</div>`;
    const root = harness.window.document.querySelector('[data-theme-region="page"]')!;
    root.innerHTML = banners(["banner-a"]) + UNIT("middle", "Middle content") + banners(["banner-b"]);
    connect(harness);
    harness.fetch.mockResolvedValueOnce(html(""));
    harness.deliver({ source: EDITOR, type: "render", body: { only: "middle" }, after: "banner-a", seq: 10, revision: 1 });
    await vi.waitFor(() => expect(harness.of("ack")).toContainEqual(expect.objectContaining({ seq: 10, status: "stale" })));
    // A unit response cannot regroup its neighbours. Keep the previous slot
    // until the editor's existing stale-ack path sends the latest full scope.
    expect(root.querySelector('[data-theme-section-id="middle"]')!.hasAttribute("hidden")).toBe(false);
    expect(harness.of("render-failed")).toEqual([]);
    let finishRegions!: (response: Response) => void;
    harness.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finishRegions = resolve; }));
    harness.deliver({ source: EDITOR, type: "render", body: { scope: { kind: "home" }, sections: [] }, after: null, seq: 11, revision: 1 });
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(2));
    // Undo schedules a unit while the pending region has not removed its mark;
    // that unit's debounce expires only after the older region has landed.
    const restored = { source: EDITOR, type: "render", body: { only: "middle" }, after: "banner-a", seq: 12, revision: 2 };
    finishRegions(html(`<div data-theme-region="page">${banners(["banner-a", "banner-b"])}</div>`));
    await vi.waitFor(() => expect(harness.of("ack")).toContainEqual(expect.objectContaining({ seq: 11, marks: ["banner-a", "banner-b"] })));
    expect(harness.window.document.querySelectorAll("[data-home-render-unit]")).toHaveLength(1);
    expect(harness.window.document.querySelector('[data-theme-section-id="middle"]')).toBeNull();
    // Its former anchor is now a grouped row, so placement needs the renderer.
    harness.fetch.mockResolvedValueOnce(html(UNIT("middle", "Restored content")));
    harness.deliver(restored);
    await vi.waitFor(() => expect(harness.of("ack")).toContainEqual(expect.objectContaining({ seq: 12, status: "stale" })));
    expect(harness.window.document.querySelector('[data-theme-section-id="middle"]')).toBeNull();
    expect(harness.window.document.querySelectorAll("[data-home-render-unit]")).toHaveLength(1);
    harness.fetch.mockResolvedValueOnce(html(`<div data-theme-region="page">${banners(["banner-a"])}${UNIT("middle", "Restored content")}${banners(["banner-b"])}</div>`));
    harness.deliver({ source: EDITOR, type: "render", body: { scope: { kind: "home" }, sections: [] }, after: null, seq: 13, revision: 2 });
    await vi.waitFor(() => expect(harness.of("ack")).toContainEqual(expect.objectContaining({ seq: 13, marks: ["banner-a", "middle", "banner-b"] })));
    expect(harness.window.document.querySelectorAll("[data-home-render-unit]")).toHaveLength(3);
    expect(harness.of("render-failed")).toEqual([]);
    expect(harness.fetch).toHaveBeenCalledTimes(4);
  });

  it("keeps requesting reconciliation if a newer empty edit supersedes the first acknowledgement", async () => {
    const harness = start(); connect(harness);
    const command = { source: EDITOR, type: "render", body: { only: "story" }, after: null };
    for (const seq of [10, 11]) {
      harness.fetch.mockResolvedValueOnce(html(""));
      harness.deliver({ ...command, seq, revision: seq });
      await vi.waitFor(() => expect(harness.of("ack")).toContainEqual(expect.objectContaining({ seq, status: "stale" })));
    }
    // The parent may ignore seq 10 after seq 11 replaces its outbox key.
    // Retrying seq 11 replays the reconciliation ack without another read.
    harness.deliver({ ...command, seq: 11, revision: 11 });
    expect(harness.of("ack").at(-1)).toMatchObject({ seq: 11, status: "stale" });
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.shown()).toEqual(["story", "faq", "seo"]);
  });

  it("reconciles the latest of overlapping empty unit responses", async () => {
    const harness = start(); connect(harness);
    const finish: Array<(response: Response) => void> = [];
    harness.fetch.mockImplementation(() => new Promise<Response>((resolve) => { finish.push(resolve); }));
    for (const seq of [10, 11]) harness.deliver({ source: EDITOR, type: "render", body: { only: "story" }, after: null, seq, revision: seq });
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(2));
    finish[1]!(html(""));
    await vi.waitFor(() => expect(harness.of("ack")).toContainEqual(expect.objectContaining({ seq: 11, status: "stale" })));
    finish[0]!(html(""));
    await vi.waitFor(() => expect(harness.of("ack")).toContainEqual(expect.objectContaining({ seq: 10, status: "stale" })));
    expect(harness.shown()).toEqual(["story", "faq", "seo"]);
    expect(harness.of("render-failed")).toEqual([]);
  });

  it("keeps ordinary nonempty FAQ edits between banners on the single-unit path", async () => {
    const harness = start();
    const root = harness.window.document.querySelector('[data-theme-region="page"]')!;
    root.innerHTML = UNIT("banner-a", "Campaign A") + UNIT("faq", "Questions") + UNIT("banner-b", "Campaign B");
    connect(harness);
    harness.fetch.mockResolvedValueOnce(html(UNIT("faq", "Updated questions")));
    harness.deliver({ source: EDITOR, type: "render", body: { only: "faq" }, after: "banner-a", seq: 10, revision: 1 });
    await vi.waitFor(() => expect(harness.of("ack")).toContainEqual({ source: "scalius-theme-preview", type: "ack", seq: 10, marks: ["banner-a", "faq", "banner-b"] }));
    expect(harness.fetch).toHaveBeenCalledTimes(1);
    expect(harness.shown()).toEqual(["banner-a", "faq", "banner-b"]);
    expect(root.textContent).toContain("Updated questions");
  });

  it.each(["hidden", "absent"])("does not reconcile an empty response for an already %s unit", async (state) => {
    const harness = start();
    const story = harness.window.document.querySelector('[data-theme-section-id="story"]')!;
    if (state === "hidden") story.setAttribute("hidden", ""); else story.remove();
    connect(harness);
    harness.fetch.mockResolvedValueOnce(html(""));
    harness.deliver({ source: EDITOR, type: "render", body: { only: "story" }, after: null, seq: 10, revision: 1 });
    await vi.waitFor(() => expect(harness.of("ack")).toHaveLength(1));
    expect(harness.of("ack")[0]).not.toHaveProperty("status");
    expect(harness.shown()).toEqual(["faq", "seo"]);
    expect(harness.fetch).toHaveBeenCalledTimes(1);
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
  it("keeps an existing unit's phone slot when a data-free replacement omits sibling context", async () => {
    const harness = start(); connect(harness);
    const old = harness.window.document.querySelector('[data-theme-section-id="story"]')!.closest('[data-home-render-unit]') as PageElement;
    old.setAttribute("style", "--phone-order:7"); old.setAttribute("data-phone-order", "7");
    harness.fetch.mockResolvedValue(html(UNIT("story", "Edited")));
    harness.deliver({ source: EDITOR, type: "render", body: { only: "story" }, after: null, seq: 20, revision: 1 });
    await vi.waitFor(() => expect(harness.of("ack")).toContainEqual(expect.objectContaining({ seq: 20 })));
    const fresh = harness.window.document.querySelector('[data-theme-section-id="story"]')!.closest('[data-home-render-unit]') as PageElement;
    expect(fresh.getAttribute("style")).toMatch(/--phone-order:\s*7/);
    expect(fresh.getAttribute("data-phone-order")).toBe("7");
  });

  it("deduplicates an in-flight retry and replays its completed ack without another fetch", async () => {
    const harness = start(); connect(harness);
    let finish!: (response: Response) => void;
    harness.fetch.mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; }));
    const command = { source: EDITOR, type: "render", body: { only: "story" }, after: null, seq: 10, revision: 1 };
    harness.deliver(command); harness.deliver(command);
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(1));
    finish(html(UNIT("story", "One render")));
    await vi.waitFor(() => expect(harness.of("ack")).toHaveLength(1));
    harness.deliver(command);
    expect(harness.fetch).toHaveBeenCalledTimes(1);
    expect(harness.of("ack")).toHaveLength(2);
    expect(harness.of("ack")[1]).toEqual(harness.of("ack")[0]);
    expect(harness.window.document.body.textContent).toContain("One render");
  });

  it("rejects an older region after a newer unit, and an older unit after a hide", async () => {
    const harness = start(); connect(harness);
    let finish!: (response: Response) => void;
    harness.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    harness.deliver({ source: EDITOR, type: "render", body: {}, after: null, seq: 1, revision: 1 });
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(1));
    harness.fetch.mockResolvedValueOnce(html(UNIT("story", "Newest")));
    harness.deliver({ source: EDITOR, type: "render", body: { only: "story" }, after: null, seq: 2, revision: 2 });
    await vi.waitFor(() => expect(harness.window.document.body.textContent).toContain("Newest"));
    finish(html(`<div data-theme-region="page">${UNIT("story", "Stale region")}</div>`));
    await vi.waitFor(() => expect(harness.of("ack")).toContainEqual(expect.objectContaining({ seq: 1, status: "stale" })));
    expect(harness.window.document.body.textContent).toContain("Newest");
    harness.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    harness.deliver({ source: EDITOR, type: "render", body: { only: "story" }, after: null, seq: 3, revision: 3 });
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(3));
    harness.deliver({ source: EDITOR, type: "arrange", region: "page", order: ["faq", "seo"], seq: 4, revision: 4 });
    finish(html(UNIT("story", "Must not revive")));
    await vi.waitFor(() => expect(harness.of("ack")).toContainEqual(expect.objectContaining({ seq: 3, status: "stale" })));
    expect(harness.shown()).toEqual(["faq", "seo"]);
  });

  it("rechecks paint after JSON resolves and retains newer token overrides", async () => {
    const harness = start(); connect(harness);
    let finish!: (result: unknown) => void;
    const json = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    harness.fetch.mockResolvedValue({ ok: true, status: 200, json });
    harness.deliver({ source: EDITOR, type: "paint", theme: {}, seq: 3, revision: 3 });
    await vi.waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    harness.deliver({ source: EDITOR, type: "tokens", vars: { "color-primary": "#123456" }, seq: 4, revision: 4 });
    finish({ css: ":root{--color-primary:#abcdef}", fonts: "stale", attributes: {} });
    await vi.waitFor(() => expect(harness.of("ack")).toContainEqual(expect.objectContaining({ seq: 3, status: "stale" })));
    expect(harness.window.document.documentElement.style.getPropertyValue("--color-primary")).toBe("#123456");
    expect(harness.window.document.querySelector("style[data-theme-fonts]")!.textContent).toBe("");
  });

  it("reports failed paint without clearing the canvas or token overrides", async () => {
    const harness = start(); connect(harness);
    const before = harness.window.document.body.innerHTML;
    harness.fetch.mockResolvedValue(html("unavailable", 503));
    harness.deliver({ source: EDITOR, type: "paint", theme: {}, seq: 5, revision: 1 });
    await vi.waitFor(() => expect(harness.of("ack")).toContainEqual(expect.objectContaining({ seq: 5, status: "failed" })));
    expect(harness.of("render-failed")).toHaveLength(1);
    expect(harness.window.document.body.innerHTML).toBe(before);
  });

});

describe("explicit field identity in the actual bridge script", () => {
  it("changes only the addressed leaf when sibling fields contain identical words", () => {
    const harness = start(); connect(harness);
    const section = harness.window.document.querySelector('[data-theme-section-id="story"]')!;
    section.innerHTML = '<h2 data-theme-field="heading">Same</h2><p data-theme-field="text">Same</p><a href="/"><span data-theme-field="cta.label">Same</span></a>';
    harness.deliver({ source: EDITOR, type: "text", id: "story", field: "heading", value: "Changed" });
    expect([...section.querySelectorAll("[data-theme-field]")].map((node) => node.textContent)).toEqual(["Changed", "Same", "Same"]);
    harness.deliver({ source: EDITOR, type: "text", id: "story", field: "cta.label", value: "<strong>plain</strong>" });
    expect(section.querySelector('[data-theme-field="cta.label"]')!.textContent).toBe("<strong>plain</strong>");
    expect(section.querySelector("strong")).toBeNull();
  });
  it("does nothing for absent or duplicate targets, nested section fields and paragraph bodies", () => {
    const harness = start(); connect(harness);
    const section = harness.window.document.querySelector('[data-theme-section-id="story"]')!;
    section.innerHTML = '<h2 data-theme-field="heading">One</h2><h2 data-theme-field="heading">Two</h2><div data-theme-field="body"><p>First</p><p>Second</p></div><section data-theme-section-id="nested"><p data-theme-field="text">Child</p></section>';
    const before = section.innerHTML;
    for (const field of ["heading", "text", "body", "items.0.question"]) harness.deliver({ source: EDITOR, type: "text", id: "story", field, value: "Wrong" });
    expect(section.innerHTML).toBe(before);
  });
  it("selects the exact field, requests editing on double click, and leaves inspector-off links native", () => {
    const harness = start(); connect(harness);
    const heading = harness.window.document.querySelector('[data-theme-field="heading"]')!;
    Object.defineProperty(heading, "getBoundingClientRect", { value: () => ({ left: 12, top: 20, width: 300, height: 42 }) });
    click(harness, heading);
    expect(harness.of("select").at(-1)).toMatchObject({ id: "story", field: "heading" });
    const htmlBefore = heading.outerHTML;
    heading.dispatchEvent(new harness.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(harness.of("edit-text")).toEqual([expect.objectContaining({ id: "story", field: "heading" })]);
    expect(heading.outerHTML).toBe(htmlBefore);
    harness.deliver({ source: EDITOR, type: "inspector", on: false });
    heading.dispatchEvent(new harness.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(harness.of("edit-text")).toHaveLength(1);
    expect(click(harness, harness.window.document.querySelector("a")!).defaultPrevented).toBe(false);
  });
  it("reports one field in viewport coordinates and clears it when its node disappears", async () => {
    const harness = start(); connect(harness);
    const heading = harness.window.document.querySelector('[data-theme-field="heading"]')!;
    Object.defineProperty(heading, "getBoundingClientRect", { value: () => ({ left: 12, top: -10, width: 300, height: 42 }) });
    Object.defineProperty(harness.window, "scrollY", { configurable: true, value: 500 });
    harness.deliver({ source: EDITOR, type: "field", target: { id: "story", field: "heading" } });
    await vi.waitFor(() => expect(harness.of("layout").at(-1)).toMatchObject({ scrollY: 500, field: { id: "story", field: "heading", rect: [12, -10, 300, 42] } }));
    heading.remove();
    harness.deliver({ source: EDITOR, type: "field", target: { id: "story", field: "heading" } });
    await vi.waitFor(() => expect(harness.of("layout").at(-1)).toMatchObject({ field: null }));
  });
});

describe("paragraph field geometry", () => {
  it("sends the first double-click box before queued selection layout, using paragraph Range geometry", () => {
    const harness = start(); connect(harness);
    const section = harness.window.document.querySelector('[data-theme-section-id="story"]')!;
    section.innerHTML = '<div data-theme-field="body" style="display: contents"><p>First</p><p>Second</p></div>';
    const range = harness.window.document.createRange();
    Object.defineProperty(range, "getBoundingClientRect", { value: () => ({ left: 12, top: -8, width: 400, height: 90 }) });
    vi.spyOn(harness.window.document, "createRange").mockReturnValue(range);
    const paragraph = section.querySelector("p")!;
    click(harness, paragraph); click(harness, paragraph);
    paragraph.dispatchEvent(new harness.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(harness.of("layout").at(-1)).toMatchObject({ field: null });
    expect(harness.of("edit-text")).toEqual([expect.objectContaining({ id: "story", field: "body", rect: [12, -8, 400, 90] })]);
    expect(section.querySelectorAll("p")).toHaveLength(2);
  });
  it("uses the existing Range measurement for display:contents body wrappers", async () => {
    const harness = start(); connect(harness);
    const section = harness.window.document.querySelector('[data-theme-section-id="story"]')!;
    section.innerHTML = '<div data-theme-field="body" style="display: contents"><p>First</p><p>Second</p></div>';
    const range = harness.window.document.createRange();
    Object.defineProperty(range, "getBoundingClientRect", { value: () => ({ left: 12, top: 88, width: 400, height: 90 }) });
    vi.spyOn(harness.window.document, "createRange").mockReturnValue(range);
    harness.deliver({ source: EDITOR, type: "field", target: { id: "story", field: "body" } });
    await vi.waitFor(() => expect(harness.of("layout").at(-1)).toMatchObject({ field: { id: "story", field: "body", rect: [12, 88, 400, 90] } }));
    expect(section.querySelectorAll("p")).toHaveLength(2);
  });
});
