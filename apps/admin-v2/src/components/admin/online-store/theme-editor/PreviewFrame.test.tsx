// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewFrame, type PreviewController } from "./PreviewFrame";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The frame's page never loads here: the test is the messages around it.
(window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;

const STOREFRONT = "https://shop.test";
const CODE = `tpc_${"c".repeat(48)}`;
const api = vi.hoisted(() => ({ platform: vi.fn(), session: vi.fn() }));

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1Platform: api.platform,
  postApiV1AdminSettingsThemePreviewSession: api.session,
}));

let root: Root;
let container: HTMLDivElement;
/** The frame's window as the dashboard sees it. */
let frameWindow: { postMessage: ReturnType<typeof vi.fn> };
const onSelect = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  api.platform.mockResolvedValue({ storefrontUrl: `${STOREFRONT}/` });
  api.session.mockResolvedValue({
    continuation: { url: `${STOREFRONT}/theme-preview/continue`, method: "POST", fields: { continuationCode: CODE, path: "/", device: "full" } },
    draftRevision: 3,
    basePublishedRevision: 1,
    expiresAt: null,
  });
  frameWindow = { postMessage: vi.fn() };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function open(options: { sourceRevision?: number; previewPath?: string } = {}) {
  const controller = createRef<PreviewController>();
  await act(async () => {
    root.render(
      <PreviewFrame
        draftRevision={3}
        {...options}
        device="desktop"
        names={{ hero: "Banners", faq: "Questions" }}
        selectedId={null}
        onSelect={onSelect}
        controller={controller}
      />,
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const iframe = container.querySelector("iframe")!;
  Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => frameWindow });
  return { iframe, controller };
}

/** A message as the browser delivers it: who sent it (window) and from where (origin). */
function deliver(data: unknown, from: { origin?: string; source?: unknown } = {}) {
  const event = new MessageEvent("message", { data, origin: from.origin ?? STOREFRONT });
  Object.defineProperty(event, "source", { value: "source" in from ? from.source : frameWindow });
  act(() => window.dispatchEvent(event));
}

const posted = () => frameWindow.postMessage.mock.calls as Array<[Record<string, unknown>, string]>;

describe("the editor's storefront frame", () => {
  it("opens the storefront's embed relay and hands it the code by message, only to the storefront origin", async () => {
    const { iframe } = await open();
    expect(api.session).toHaveBeenCalledWith({ body: { expectedDraftRevision: 3, path: "/", device: "full" } });
    expect(iframe.getAttribute("src")).toBe(`${STOREFRONT}/theme-preview/embed`);
    expect(iframe.getAttribute("src")).not.toContain(CODE);
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");

    // A relay on another origin, or another window, never receives the code.
    deliver({ type: "scalius-continuation-ready-v1" }, { origin: "https://evil.test" });
    deliver({ type: "scalius-continuation-ready-v1" }, { source: {} });
    expect(posted()).toEqual([]);
    deliver({ type: "scalius-continuation-ready-v1" });
    expect(posted()).toEqual([[{ type: "scalius-continuation-fields-v1", fields: { continuationCode: CODE, path: "/", device: "full" } }, STOREFRONT]]);
    // Once accepted, the spent code is never sent again.
    deliver({ type: "scalius-continuation-accepted-v1" });
    deliver({ type: "scalius-continuation-ready-v1" });
    expect(posted()).toHaveLength(1);
  });

  it("answers the bridge's hello with the section names, and ignores the same message from elsewhere", async () => {
    await open();
    deliver({ source: "scalius-theme-preview", type: "hello", path: "/" }, { origin: "https://shop.test.evil.test" });
    deliver({ source: "scalius-theme-preview", type: "hello", path: "/" }, { origin: "http://shop.test" });
    expect(posted()).toEqual([]);
    deliver({ source: "scalius-theme-preview", type: "hello", path: "/" });
    expect(posted()).toEqual([[
      { source: "scalius-theme-editor", type: "connect", names: { hero: "Banners", faq: "Questions" }, selected: null },
      STOREFRONT,
    ]]);
    deliver({ source: "scalius-theme-preview", type: "ready", path: "/", sections: ["hero", "faq"] });
    expect(container.querySelector("[role=status]")).toBeNull();
  });

  it("selects only what the storefront's own frame names, in a valid message", async () => {
    await open();
    deliver({ source: "scalius-theme-preview", type: "hello", path: "/" });
    deliver({ source: "scalius-theme-preview", type: "select", sectionId: "faq" }, { origin: "https://evil.test" });
    deliver({ source: "scalius-theme-preview", type: "select", sectionId: "faq" }, { source: window });
    deliver({ source: "scalius-theme-preview", type: "select", sectionId: "<img onerror>" });
    deliver({ source: "elsewhere", type: "select", sectionId: "faq" });
    expect(onSelect).not.toHaveBeenCalled();
    deliver({ source: "scalius-theme-preview", type: "select", sectionId: "faq" });
    expect(onSelect).toHaveBeenCalledWith("faq");
  });

  it("sends commands to the storefront origin only once the bridge is connected", async () => {
    const { controller } = await open();
    act(() => controller.current!.send({ type: "section-updated", sectionIds: ["faq"] }));
    expect(posted()).toEqual([]);
    deliver({ source: "scalius-theme-preview", type: "hello", path: "/" });
    act(() => controller.current!.send({ type: "section-updated", sectionIds: ["faq"] }));
    expect(posted().at(-1)).toEqual([{ source: "scalius-theme-editor", type: "section-updated", sectionIds: ["faq"] }, STOREFRONT]);
  });

  it("opens a new session when the preview session expires", async () => {
    await open();
    deliver({ source: "scalius-theme-preview", type: "hello", path: "/" });
    deliver({ source: "scalius-theme-preview", type: "expired" });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(api.session).toHaveBeenCalledTimes(2);
  });

  it("asks for a Store URL when Platform settings have none", async () => {
    api.platform.mockResolvedValue({ storefrontUrl: "" });
    await act(async () => {
      root.render(<PreviewFrame draftRevision={3} device="phone" names={{}} selectedId={null} onSelect={onSelect} controller={createRef()} />);
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).toContain("Set your Store URL");
    expect(api.session).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).toBeNull();
  });
  it("starts an immutable version session at a landing page, without sending its bearer in a URL", async () => {
    api.session.mockResolvedValue({ continuation: { url: `${STOREFRONT}/theme-preview/continue`, method: "POST", fields: { continuationCode: CODE, path: "/pages/eid-offers", device: "full" } }, draftRevision: 3, basePublishedRevision: 1 });
    await open({ sourceRevision: 8, previewPath: "/pages/eid-offers" });
    expect(api.session).toHaveBeenCalledWith({ body: { expectedDraftRevision: 3, sourceRevision: 8, path: "/pages/eid-offers", device: "full" } });
    deliver({ type: "scalius-continuation-ready-v1" });
    expect(posted().at(-1)?.[0]).toMatchObject({ fields: { path: "/pages/eid-offers", continuationCode: CODE } });
    expect(container.querySelector("iframe")?.getAttribute("src")).not.toContain(CODE);
  });

  it("opens a new session when the merchant changes template or historical version", async () => {
    const { controller } = await open();
    api.session.mockResolvedValue({ continuation: { url: `${STOREFRONT}/theme-preview/continue`, method: "POST", fields: { continuationCode: CODE, path: "/search", device: "full" } }, draftRevision: 3, basePublishedRevision: 1 });
    await act(async () => root.render(<PreviewFrame draftRevision={3} sourceRevision={8} previewPath="/search" device="tablet" names={{}} selectedId={null} onSelect={onSelect} controller={controller} />));
    expect(api.session).toHaveBeenCalledTimes(2);
    expect(api.session.mock.calls.at(-1)![0].body).toMatchObject({ sourceRevision: 8, path: "/search" });
    expect(container.querySelector("[data-device]")?.getAttribute("style")).toContain("768px");
    await act(async () => root.render(<PreviewFrame draftRevision={3} sourceRevision={8} previewPath="/search" device="phone" names={{}} selectedId={null} onSelect={onSelect} controller={controller} />));
    expect(api.session).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-device]")?.getAttribute("style")).toContain("390px");
  });

  it("keeps the newest page when an earlier session answers last", async () => {
    const continuation = (path: string, code: string) => ({
      continuation: { url: `${STOREFRONT}/theme-preview/continue`, method: "POST", fields: { continuationCode: code, path, device: "full" } },
      draftRevision: 3,
      basePublishedRevision: 1,
    });
    let resolveSlow: (value: ReturnType<typeof continuation>) => void = () => {};
    const slow = { promise: new Promise<ReturnType<typeof continuation>>((resolve) => { resolveSlow = resolve; }), resolve: (value: ReturnType<typeof continuation>) => resolveSlow(value) };
    api.session.mockReturnValueOnce(slow.promise);
    const controller = createRef<PreviewController>();
    const frame = (previewPath: string) => (
      <PreviewFrame draftRevision={3} previewPath={previewPath} device="desktop" names={{}} selectedId={null} onSelect={onSelect} controller={controller} />
    );
    await act(async () => root.render(frame("/products/honey")));
    // The merchant moves to Search before the product's session answers.
    const SEARCH_CODE = `tpc_${"s".repeat(48)}`;
    api.session.mockResolvedValueOnce(continuation("/search", SEARCH_CODE));
    await act(async () => root.render(frame("/search")));
    await act(async () => slow.resolve(continuation("/products/honey", CODE)));
    // The product's late answer is dropped: no failure, and the frame opens Search.
    expect(container.textContent).not.toContain("Try again");
    const iframe = container.querySelector("iframe")!;
    Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => frameWindow });
    deliver({ type: "scalius-continuation-ready-v1" });
    expect(posted().at(-1)?.[0]).toMatchObject({ fields: { path: "/search", continuationCode: SEARCH_CODE } });
  });
});
