// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { themePreviewBridgeScript } from "./theme-preview-bridge";

const DASHBOARD = "https://admin.shop.test";
const PAGE = `
  <div class="flex flex-col" data-theme-preview-layout="L1">
    <div class="contents home-render-unit" data-home-render-unit data-theme-section-id="story">
      <section><h2>Our story</h2><a href="/about">Read more</a></section>
    </div>
    <div class="contents home-render-unit" data-home-render-unit data-theme-section-id="faq">
      <section><h2>Questions</h2></section>
    </div>
  </div>`;

interface Harness {
  window: Window;
  parent: { postMessage: ReturnType<typeof vi.fn> };
  fetch: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  /** A message as the browser delivers it, from the parent at the dashboard origin unless told otherwise. */
  deliver(data: unknown, from?: { origin?: string; source?: unknown }): void;
  posted(): Array<[Record<string, unknown>, string]>;
}

const windows: Window[] = [];
afterEach(async () => {
  for (const each of windows.splice(0)) await each.happyDOM.close();
});

function start(dashboard = DASHBOARD): Harness {
  const window = new Window({ url: "https://shop.test/", settings: { enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  windows.push(window);
  window.document.body.innerHTML = PAGE;
  const parent = { postMessage: vi.fn() };
  const fetch = vi.fn();
  const reload = vi.fn();
  Object.defineProperty(window, "parent", { configurable: true, value: parent });
  Object.defineProperty(window, "fetch", { configurable: true, value: fetch });
  Object.defineProperty(window.location, "reload", { configurable: true, value: reload });
  const script = window.document.createElement("script");
  script.textContent = themePreviewBridgeScript(dashboard);
  window.document.body.append(script);
  return {
    window,
    parent,
    fetch,
    reload,
    deliver(data, from = {}) {
      const event = new window.MessageEvent("message", { data, origin: from.origin ?? DASHBOARD });
      Object.defineProperty(event, "source", { value: "source" in from ? from.source : parent });
      window.dispatchEvent(event);
    },
    posted: () => parent.postMessage.mock.calls as Array<[Record<string, unknown>, string]>,
  };
}

const connect = (harness: Harness) =>
  harness.deliver({ source: "scalius-theme-editor", type: "connect", names: { story: "Text and images", faq: "Questions and answers" }, selected: null });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the storefront preview bridge", () => {
  it("is nothing without a dashboard origin", () => {
    expect(themePreviewBridgeScript("")).toBe("");
  });

  it("says hello to the dashboard origin only, and starts only when the dashboard answers", () => {
    const harness = start();
    expect(harness.posted()).toEqual([[{ source: "scalius-theme-preview", type: "hello", path: "/" }, DASHBOARD]]);
    // The same answer from another origin, another window or another sender does nothing.
    harness.deliver({ source: "scalius-theme-editor", type: "connect", names: {}, selected: null }, { origin: "https://evil.test" });
    harness.deliver({ source: "scalius-theme-editor", type: "connect", names: {}, selected: null }, { origin: "https://admin.shop.test.evil.test" });
    harness.deliver({ source: "scalius-theme-editor", type: "connect", names: {}, selected: null }, { source: {} });
    harness.deliver({ source: "elsewhere", type: "connect", names: {}, selected: null });
    expect(harness.posted()).toHaveLength(1);
    connect(harness);
    expect(harness.posted().at(-1)).toEqual([{ source: "scalius-theme-preview", type: "ready", path: "/", sections: ["story", "faq"] }, DASHBOARD]);
  });

  it("reports a click as a selection once connected, keeping links inside sections in place", () => {
    const harness = start();
    const link = harness.window.document.querySelector("a")!;
    const before = new harness.window.MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);
    expect(harness.posted()).toHaveLength(1);
    connect(harness);
    const click = new harness.window.MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(harness.posted().at(-1)).toEqual([{ source: "scalius-theme-preview", type: "select", sectionId: "story" }, DASHBOARD]);
  });

  it("swaps an updated section in place when the page layout is unchanged", async () => {
    const harness = start();
    connect(harness);
    harness.fetch.mockResolvedValue(new Response(
      '<div data-theme-preview-unit data-theme-preview-layout="L1"><div class="contents home-render-unit" data-home-render-unit data-theme-section-id="story"><section><h2>Our new story</h2></section></div></div>',
      { status: 200, headers: { "Content-Type": "text/html" } },
    ));
    harness.deliver({ source: "scalius-theme-editor", type: "section-updated", sectionIds: ["story"] });
    await settle();
    await settle();
    expect(harness.fetch).toHaveBeenCalledWith("/theme-preview/section?id=story", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    expect(harness.window.document.body.textContent).toContain("Our new story");
    expect(harness.window.document.body.textContent).toContain("Questions");
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("loads the page again when the layout moved or the section has scripts", async () => {
    for (const html of [
      '<div data-theme-preview-unit data-theme-preview-layout="L2"><div data-home-render-unit data-theme-section-id="story"></div></div>',
      '<div data-theme-preview-unit data-theme-preview-layout="L1"><div data-home-render-unit data-theme-section-id="story"><script>1</script></div></div>',
    ]) {
      const harness = start();
      connect(harness);
      harness.fetch.mockResolvedValue(new Response(html, { status: 200 }));
      harness.deliver({ source: "scalius-theme-editor", type: "section-updated", sectionIds: ["story"] });
      await settle();
      await settle();
      expect(harness.reload).toHaveBeenCalledTimes(1);
      expect(harness.window.sessionStorage.getItem("scalius-theme-preview-scroll")).toBe("0");
    }
  });

  it("tells the dashboard when the preview session ended", async () => {
    const harness = start();
    connect(harness);
    harness.fetch.mockResolvedValue(new Response(null, { status: 401 }));
    harness.deliver({ source: "scalius-theme-editor", type: "section-updated", sectionIds: ["faq"] });
    await settle();
    await settle();
    expect(harness.posted().at(-1)).toEqual([{ source: "scalius-theme-preview", type: "expired" }, DASHBOARD]);
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("refuses section ids it would not render, and reloads on request", () => {
    const harness = start();
    connect(harness);
    harness.deliver({ source: "scalius-theme-editor", type: "section-updated", sectionIds: ['story"] , body'] });
    expect(harness.fetch).not.toHaveBeenCalled();
    harness.deliver({ source: "scalius-theme-editor", type: "reload" }, { origin: "https://evil.test" });
    expect(harness.reload).not.toHaveBeenCalled();
    harness.deliver({ source: "scalius-theme-editor", type: "reload" });
    expect(harness.reload).toHaveBeenCalledTimes(1);
  });
});
