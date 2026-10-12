// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
/**
 * The preview channel as the editor really runs it: the hook, the canvas
 * (its frames registered by ref) and re-renders after the frame connected.
 * The frame's window is a fake that records what the editor posts, and
 * messages from it arrive as window `message` events from the storefront
 * origin, as a browser delivers them.
 */
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";
import { EditorCanvas } from "./EditorCanvas";
import {
  PREVIEW_ACK_TIMEOUT_MS,
  PREVIEW_MAX_SENDS,
  PREVIEW_RENDER_ACK_TIMEOUT_MS,
  previewCommandKey,
  usePreview,
  type PreviewCommand,
} from "./use-preview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORE = "https://shop.test";
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1Platform: vi.fn(async () => ({ storefrontUrl: "https://shop.test" })),
  postApiV1AdminSettingsThemePreviewSession: vi.fn(async () => ({ continuation: { fields: { continuationCode: "tpc_test", path: "/", device: "full" } } })),
}));
vi.mock("../theme-preview", () => ({ isSafeThemePreviewContinuation: () => true }));

interface FakeWindow { postMessage: ReturnType<typeof vi.fn> }
const windows = new Map<Element, FakeWindow>();
const windowOf = (frame: HTMLIFrameElement) => {
  let fake = windows.get(frame);
  if (!fake) windows.set(frame, (fake = { postMessage: vi.fn() }));
  return fake;
};

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let root: Root;
let container: HTMLDivElement;
const handle: { preview: ReturnType<typeof usePreview> | null; rerender: Dispatch<SetStateAction<number>> | null } = { preview: null, rerender: null };
const connectedCount = { value: 0 };
const selectedField = vi.fn();
const editText = vi.fn();
let setSourceRevision: Dispatch<SetStateAction<number | null>>;

function Harness() {
  const [tick, setTick] = useState(0);
  const [sourceRevision, setRevision] = useState<number | null>(null);
  setSourceRevision = setRevision;
  handle.rerender = setTick;
  const preview = usePreview({
    draftRevision: 3,
    sourceRevision,
    path: "/",
    inspector: true,
    onSelect: selectedField,
    onEditText: editText,
    onKey: () => {},
    onConnected: () => { connectedCount.value += 1; },
  });
  handle.preview = preview;
  return (
    <div data-tick={tick}>
      <EditorCanvas
        device="desktop"
        desktopWidth={1280}
        zoom="fit"
        phase={preview.phase}
        frames={preview.frames}
        activeId={preview.activeId}
        register={preview.register}
        layout={preview.layout}
        hovered={null}
        selected={null}
        names={{}}
        actions={null}
        onRetry={() => {}}
        onScaleChange={() => {}}
      />
    </div>
  );
}

const frames = () => [...container.querySelectorAll<HTMLIFrameElement>("iframe")];
const deliver = (frame: HTMLIFrameElement, data: Record<string, unknown>) => act(() => {
  window.dispatchEvent(new MessageEvent("message", { data: { source: "scalius-theme-preview", ...data }, origin: STORE, source: windowOf(frame) as unknown as Window }));
});
const deliverRaw = (frame: HTMLIFrameElement, data: Record<string, unknown>) => act(() => {
  window.dispatchEvent(new MessageEvent("message", { data, origin: STORE, source: windowOf(frame) as unknown as Window }));
});
/** What the editor posted to a frame (bridge messages only). */
const posted = (frame: HTMLIFrameElement) => windowOf(frame).postMessage.mock.calls
  .map(([message]) => message as { source?: string; type: string; seq?: number })
  .filter((message) => message.source === "scalius-theme-editor");
const rerender = () => act(() => handle.rerender!((tick) => tick + 1));
const send = (command: PreviewCommand) => act(() => handle.preview!.send(command));

/** Opens a session and connects its first frame, as the relay and bridge do. */
async function connectFirstFrame() {
  await act(async () => { root.render(<Harness />); });
  await vi.waitFor(() => expect(frames()).toHaveLength(1));
  const frame = frames()[0]!;
  deliverRaw(frame, { type: "scalius-continuation-ready-v1" });
  expect(windowOf(frame).postMessage).toHaveBeenCalledWith({ type: "scalius-continuation-fields-v1", fields: { continuationCode: "tpc_test", path: "/", device: "full" } }, STORE);
  deliver(frame, { type: "hello", path: "/" });
  expect(posted(frame)).toEqual([{ source: "scalius-theme-editor", type: "connect", inspector: true, scrollY: null }]);
  deliver(frame, { type: "ready", path: "/", marks: ["header", "hero", "faq"] });
  expect(handle.preview!.phase).toBe("ready");
  // The page acknowledges what the editor queued before it connected (the inspector's state).
  for (const message of posted(frame)) if (message.seq) deliver(frame, { type: "ack", seq: message.seq });
  return frame;
}

const COMMANDS: PreviewCommand[] = [
  { type: "inspector", on: false },
  { type: "reveal", id: "faq" },
  { type: "tokens", vars: { "color-bg": "#ffffff" } },
  { type: "paint", theme: { version: 8 } },
  { type: "text", id: "faq", field: "heading", value: "Questions?" },
  { type: "arrange", region: "page", order: ["faq", "hero"] },
  { type: "render", body: { scope: { kind: "home" }, sections: [], only: "faq" }, after: null },
];

beforeEach(() => {
  act(() => setLocale("en"));
  windows.clear();
  connectedCount.value = 0;
  selectedField.mockClear();
  editText.mockClear();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("")));
  vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockImplementation(function (this: HTMLIFrameElement) {
    return windowOf(this) as unknown as Window;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  container.remove();
});

describe("the preview channel", () => {
  it("delivers every command kind after the editor re-rendered (frames keep their registration)", async () => {
    const frame = await connectFirstFrame();
    rerender();
    rerender();
    windowOf(frame).postMessage.mockClear();
    for (const command of COMMANDS) send(command);
    const sent = posted(frame);
    expect(sent.map((message) => message.type)).toEqual(COMMANDS.map((command) => command.type));
    // Each carries a growing sequence number for its ack.
    expect(sent.map((message) => message.seq)).toEqual([...sent.map((message) => message.seq)].sort((a, b) => a! - b!));
    expect(new Set(sent.map((message) => message.seq)).size).toBe(COMMANDS.length);
  });

  it("keeps the connection when React detaches and re-attaches the same frame (a real browser does this on re-renders)", async () => {
    const frame = await connectFirstFrame();
    // React calls a ref callback with null, then with the element again, when
    // the iframe re-attaches. Before the fix the null forgot the connection and
    // every later command was silently dropped (the owner's "edits never show").
    const callback = handle.preview!.register(handle.preview!.activeId!);
    act(() => { callback(null); callback(frame); });
    rerender();
    windowOf(frame).postMessage.mockClear();
    for (const command of COMMANDS) send(command);
    expect(posted(frame).map((message) => message.type)).toEqual(COMMANDS.map((command) => command.type));
  });

  it("sends a command again until the page acknowledges it", async () => {
    const frame = await connectFirstFrame();
    vi.useFakeTimers();
    send({ type: "tokens", vars: { "color-bg": "#000000" } });
    send({ type: "render", body: { scope: { kind: "home" }, sections: [] }, after: null });
    const [tokens, render] = posted(frame).slice(-2);
    deliver(frame, { type: "ack", seq: tokens!.seq });
    windowOf(frame).postMessage.mockClear();
    act(() => { vi.advanceTimersByTime(PREVIEW_ACK_TIMEOUT_MS + 250); });
    // The acknowledged tokens stay sent; the render is not late yet.
    expect(posted(frame)).toEqual([]);
    act(() => { vi.advanceTimersByTime(PREVIEW_RENDER_ACK_TIMEOUT_MS); });
    expect(posted(frame)).toEqual([expect.objectContaining({ type: "render", seq: render!.seq })]);
    deliver(frame, { type: "ack", seq: render!.seq, marks: ["header", "faq"] });
    windowOf(frame).postMessage.mockClear();
    act(() => { vi.advanceTimersByTime(PREVIEW_RENDER_ACK_TIMEOUT_MS * 2); });
    expect(posted(frame)).toEqual([]);
    expect(handle.preview!.marks).toEqual(["header", "faq"]);
  });

  it("keeps only the newest command of a kind, and an old ack does not clear a newer one", async () => {
    const frame = await connectFirstFrame();
    vi.useFakeTimers();
    send({ type: "tokens", vars: { "color-bg": "#111111" } });
    send({ type: "tokens", vars: { "color-bg": "#222222" } });
    const [older, newer] = posted(frame).slice(-2);
    deliver(frame, { type: "ack", seq: older!.seq });
    windowOf(frame).postMessage.mockClear();
    act(() => { vi.advanceTimersByTime(PREVIEW_ACK_TIMEOUT_MS + 250); });
    expect(posted(frame)).toEqual([expect.objectContaining({ type: "tokens", seq: newer!.seq, vars: { "color-bg": "#222222" } })]);
  });

  it("loses nothing while the frame navigates: unacknowledged commands go again when it connects", async () => {
    const frame = await connectFirstFrame();
    // Fast typing: each keystroke patches the text, and the section is drawn again.
    for (let at = 1; at <= 20; at += 1) {
      send({ type: "text", id: "faq", field: "heading", value: "Q".repeat(at + 1) });
      send({ type: "render", body: { scope: { kind: "home" }, sections: [], only: "faq", n: at }, after: null });
    }
    send({ type: "tokens", vars: { "color-bg": "#333333" } });
    // The page navigates (a link with the inspector off): the new document says hello and gets ready.
    windowOf(frame).postMessage.mockClear();
    deliver(frame, { type: "hello", path: "/collections/eid" });
    deliver(frame, { type: "ready", path: "/collections/eid", marks: ["header"] });
    const again = posted(frame).filter((message) => message.type !== "connect" && message.type !== "inspector");
    // The newest render and tokens, never a stale one; text patches chain, so the render carries the words.
    expect(again).toEqual([
      expect.objectContaining({ type: "render", body: expect.objectContaining({ n: 20 }) }),
      expect.objectContaining({ type: "tokens", vars: { "color-bg": "#333333" } }),
    ]);
  });

  it("carries unacknowledged commands to the frame that replaces the shown one", async () => {
    const first = await connectFirstFrame();
    send({ type: "arrange", region: "page", order: ["faq"] });
    act(() => handle.preview!.reload());
    await vi.waitFor(() => expect(frames()).toHaveLength(2));
    const second = frames()[1]!;
    deliver(second, { type: "hello", path: "/" });
    expect(posted(second)).toEqual([{ source: "scalius-theme-editor", type: "connect", inspector: true, scrollY: 0 }]);
    deliver(second, { type: "ready", path: "/", marks: ["header", "faq"] });
    await vi.waitFor(() => expect(frames()).toHaveLength(1));
    expect(posted(second)).toContainEqual(expect.objectContaining({ type: "arrange", order: ["faq"] }));
    expect(connectedCount.value).toBe(2);
    // Later commands go to the new frame only, after more re-renders.
    rerender();
    windowOf(first).postMessage.mockClear();
    send({ type: "reveal", id: "faq" });
    expect(posted(second).at(-1)).toMatchObject({ type: "reveal", id: "faq" });
    expect(posted(first)).toEqual([]);
  });

  it("loads the page again when it never answers", async () => {
    await connectFirstFrame();
    vi.useFakeTimers();
    send({ type: "reveal", id: "faq" });
    act(() => { vi.advanceTimersByTime((PREVIEW_ACK_TIMEOUT_MS + 200) * (PREVIEW_MAX_SENDS + 1)); });
    expect(frames()).toHaveLength(2);
  });

  it("keys commands by what they replace", () => {
    expect(previewCommandKey({ type: "text", id: "faq", field: "heading", value: "b" })).toBeNull();
    expect(previewCommandKey({ type: "arrange", region: "before", order: [] })).toBe("arrange:before");
    expect(previewCommandKey({ type: "render", body: { only: "faq" }, after: null })).toBe("render:faq");
    expect(previewCommandKey({ type: "render", body: {}, after: null })).toBe("render:regions");
    expect(previewCommandKey({ type: "tokens", vars: {} })).toBe("tokens");
  });
  it("keeps the active canvas on render failure and asks for one resync on a stale ack", async () => {
    const frame = await connectFirstFrame();
    send({ type: "render", body: { only: "faq" }, after: null, revision: 1 });
    const first = posted(frame).at(-1)!;
    deliver(frame, { type: "render-failed" });
    deliver(frame, { type: "ack", seq: first.seq, status: "failed" });
    expect(frames()).toEqual([frame]);
    expect(handle.preview!.phase).toBe("ready");
    expect(handle.preview!.failed).toBe(true);
    send({ type: "render", body: { only: "faq" }, after: null, revision: 2 });
    const second = posted(frame).at(-1)!;
    deliver(frame, { type: "ack", seq: second.seq, status: "stale" });
    expect(handle.preview!.resyncAt).toBe(1);
    deliver(frame, { type: "ack", seq: second.seq, status: "stale" });
    expect(handle.preview!.resyncAt).toBe(1);
    send({ type: "render", body: {}, after: null, revision: 2 });
    deliver(frame, { type: "ack", seq: posted(frame).at(-1)!.seq });
    expect(handle.preview!.failed).toBe(false);
  });

  it("does not send or replay working edits to a historical frame", async () => {
    const old = await connectFirstFrame();
    send({ type: "render", body: { only: "faq" }, after: null, revision: 1 });
    act(() => setSourceRevision(4));
    await act(async () => {});
    await vi.waitFor(() => expect(frames()).toHaveLength(1));
    const historical = frames()[0]!;
    expect(historical).not.toBe(old);
    deliver(historical, { type: "hello", path: "/" });
    deliver(historical, { type: "ready", path: "/", marks: ["faq"] });
    send({ type: "tokens", vars: { "color-bg": "#123456" }, revision: 2 });
    send({ type: "render", body: {}, after: null, revision: 2 });
    expect(posted(historical).filter(command => ["tokens", "paint", "text", "arrange", "render"].includes(command.type))).toEqual([]);
    send({ type: "reveal", id: "faq" });
    expect(posted(historical).at(-1)).toMatchObject({ type: "reveal", id: "faq" });
  });

  it("ignores a superseded same-key stale ack instead of feeding reconciliation", async () => {
    const frame = await connectFirstFrame();
    send({ type: "render", body: {}, after: null, revision: 1 });
    const old = posted(frame).at(-1)!;
    send({ type: "render", body: {}, after: null, revision: 1 });
    const replacement = posted(frame).at(-1)!;
    deliver(frame, { type: "ack", seq: old.seq, status: "stale" });
    expect(handle.preview!.resyncAt).toBe(0);
    deliver(frame, { type: "ack", seq: replacement.seq, marks: ["faq"] });
    expect(handle.preview!.resyncAt).toBe(0);
    expect(frames()).toEqual([frame]);
  });

});

describe("frame-specific scalar text capability", () => {
  it("forwards a validated gesture box without waiting for field layout", async () => {
    const frame = await connectFirstFrame();
    deliver(frame, { type: "ready", path: "/", marks: ["faq"], fields: 1 });
    expect(handle.preview!.layout.field).toBeUndefined();
    deliver(frame, { type: "edit-text", id: "faq", field: "heading", rect: [10, 20, Infinity, 40] });
    expect(editText).not.toHaveBeenCalled();
    deliver(frame, { type: "edit-text", id: "faq", field: "heading", rect: [10, 20, 300, 40] });
    expect(editText).toHaveBeenCalledExactlyOnceWith("faq", "heading", [10, 20, 300, 40]);
  });
  it("defaults older bridges to canonical rendering and drops field events from replaced frames", async () => {
    const first = await connectFirstFrame();
    expect(handle.preview!.fieldsEnabled).toBe(false);
    deliver(first, { type: "ready", path: "/", marks: ["faq"], fields: 1 });
    expect(handle.preview!.fieldsEnabled).toBe(true);
    deliver(first, { type: "select", id: "faq", field: "heading" });
    expect(selectedField).toHaveBeenLastCalledWith("faq", "heading");
    act(() => handle.preview!.reload());
    await vi.waitFor(() => expect(frames()).toHaveLength(2));
    const second = frames()[1]!;
    deliver(second, { type: "hello", path: "/" });
    deliver(second, { type: "ready", path: "/", marks: ["faq"] });
    expect(handle.preview!.fieldsEnabled).toBe(false);
    const before = editText.mock.calls.length;
    deliver(first, { type: "edit-text", id: "faq", field: "heading", rect: [10, 20, 300, 40] });
    expect(editText).toHaveBeenCalledTimes(before);
  });
});
