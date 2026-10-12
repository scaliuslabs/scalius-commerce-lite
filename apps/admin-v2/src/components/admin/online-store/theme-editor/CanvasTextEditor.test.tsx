// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STOREFRONT_THEME } from "@scalius/shared/storefront-theme";
import { CanvasTextEditor, type CanvasTextHandle, type CanvasTextSession } from "./CanvasTextEditor";
import { EditorCanvas } from "./EditorCanvas";
import { frameBox } from "./canvas-geometry";
import { setLocale } from "~/i18n";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const commit = vi.fn();
const close = vi.fn();
const ref = createRef<CanvasTextHandle>();
const box = frameBox({ width: 1000, height: 700 }, "desktop", 1280, "fit");
const session: CanvasTextSession = { nonce: 1, target: { page: { kind: "home" }, id: "a", type: "banner", field: "heading", layout: "full", baseline: "Original" },
  label: "Heading", multiline: false, maxLength: 160, rect: [10, 20, 500, 50] };
function render(multiline = false) { act(() => root.render(<CanvasTextEditor session={{ ...session, multiline }} box={box} controlRef={ref} onCommit={commit} onClose={close} />)); }
const input = () => host.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
const key = (name: string, extra: KeyboardEventInit = {}) => act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...extra })));
const compose = (name: string) => act(() => input().dispatchEvent(new CompositionEvent(name, { bubbles: true })));
const value = (text: string) => { input().value = text; act(() => input().dispatchEvent(new Event("input", { bubbles: true }))); };
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); setLocale("en"); commit.mockReturnValue({ ok: true, theme: DEFAULT_STOREFRONT_THEME }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("native canvas text buffer", () => {
  it("does not write on mount or typing, applies once, and survives geometry updates", () => {
    render(); const original = input(); value("Changed"); render();
    expect(input()).toBe(original); expect(input().value).toBe("Changed"); expect(commit).not.toHaveBeenCalled();
    key("Enter"); act(() => ref.current?.finish());
    expect(commit).toHaveBeenCalledExactlyOnceWith("Changed", "Original"); expect(close).toHaveBeenCalledTimes(1);
  });
  it("Escape cancels without a draft write", () => { render(); value("Discard"); key("Escape"); expect(commit).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); });
  it("keeps multiline Enter native and applies with Ctrl+Enter", () => { render(true); value("One\n\nTwo <plain>"); key("Enter"); expect(commit).not.toHaveBeenCalled(); key("Enter", { ctrlKey: true }); expect(commit).toHaveBeenCalledExactlyOnceWith("One\n\nTwo <plain>", "Original"); });
  it("does not commit IME confirmation Enter, including the compositionend task", () => {
    render(); compose("compositionstart"); value("বাংলা"); key("Enter", { isComposing: true });
    compose("compositionend"); key("Enter"); expect(commit).not.toHaveBeenCalled();
    act(() => vi.runOnlyPendingTimers()); expect(commit).not.toHaveBeenCalled();
    key("Enter"); expect(commit).toHaveBeenCalledExactlyOnceWith("বাংলা", "Original");
  });
  it("defers a context switch until composition finishes and commits exactly once", () => {
    render(); compose("compositionstart"); value("বাংলা"); const next = vi.fn();
    act(() => ref.current?.finish(next)); expect(next).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
    compose("compositionend"); act(() => vi.runOnlyPendingTimers());
    expect(commit).toHaveBeenCalledExactlyOnceWith("বাংলা", "Original"); expect(next).toHaveBeenCalledOnce();
  });
  it("defers composition blur, but ordinary blur applies the buffer", () => {
    render(); compose("compositionstart"); value("Final");
    act(() => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null })));
    expect(commit).not.toHaveBeenCalled(); compose("compositionend"); act(() => vi.runOnlyPendingTimers());
    expect(commit).toHaveBeenCalledExactlyOnceWith("Final", "Original");
  });
  it("retains a conflicting buffer and uses the observed current value only after Replace", () => {
    commit.mockReturnValueOnce({ ok: false, reason: "changed", current: "Remote" });
    render(); value("Mine"); key("Enter"); expect(close).not.toHaveBeenCalled(); expect(input().value).toBe("Mine");
    act(() => ref.current?.finish()); expect(commit).toHaveBeenCalledTimes(1);
    const replace = [...host.querySelectorAll("button")].find((button) => button.textContent === "Replace text")!;
    act(() => replace.click()); expect(commit).toHaveBeenLastCalledWith("Mine", "Remote"); expect(close).toHaveBeenCalledOnce();
  });
});

describe("canvas blur and deferred-authority regressions", () => {
  it("prevents a non-focusing Cancel button from blurring and committing first", () => {
    render(); value("Discard");
    const cancel = [...host.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => cancel.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    act(() => cancel.click());
    expect(commit).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });
  it("deferred completion reads the latest callback and preserves a newly conflicting buffer", () => {
    render(); compose("compositionstart"); value("Mine");
    const next = vi.fn(); act(() => ref.current?.finish(next));
    const changed = vi.fn(() => ({ ok: false as const, reason: "changed" as const, current: "Remote" }));
    act(() => root.render(<CanvasTextEditor session={session} box={box} controlRef={ref} onCommit={changed} onClose={close} />));
    compose("compositionend"); act(() => vi.runOnlyPendingTimers());
    expect(commit).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledExactlyOnceWith("Mine", "Original");
    expect(next).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(input().value).toBe("Mine");
  });
  it("retries a transient refusal without discarding the buffer", () => {
    commit.mockReturnValueOnce({ ok: false, reason: "missing" });
    render(); value("Mine"); key("Enter"); expect(close).not.toHaveBeenCalled();
    key("Enter"); expect(commit).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledOnce();
  });
  it("keeps a requested context action when a later blur occurs during composition", () => {
    render(); compose("compositionstart"); value("Mine"); const next = vi.fn();
    act(() => ref.current?.finish(next));
    act(() => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null })));
    compose("compositionend"); act(() => vi.runOnlyPendingTimers());
    expect(next).toHaveBeenCalledOnce(); expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe("one canvas editing surface across preview phases", () => {
  it("keeps the same native buffer when the iframe reconnects", () => {
    const snapshot = { layout: { rects: {}, scrollY: 0, height: 1000 }, hovered: null };
    const visuals = { getSnapshot: () => snapshot, subscribe: () => () => {} };
    const draw = (phase: "ready" | "connecting") => act(() => root.render(<EditorCanvas
      device="desktop" desktopWidth={1280} zoom="fit" phase={phase} frames={[]} activeId={null} register={() => () => {}}
      visuals={visuals} inspector={true} hovered={null} selected={null} names={{}} actions={null}
      onRetry={() => {}} onScaleChange={() => {}}
      textEditor={(currentBox) => <CanvasTextEditor key={session.nonce} session={session} box={currentBox} controlRef={ref} onCommit={commit} onClose={close} />}
    />));
    draw("ready"); const original = input(); value("Still composing");
    compose("compositionstart"); draw("connecting");
    expect(host.querySelectorAll("[data-canvas-text-editor]")).toHaveLength(1);
    expect(input()).toBe(original); expect(input().value).toBe("Still composing");
    draw("ready"); expect(input()).toBe(original); expect(commit).not.toHaveBeenCalled();
  });
});
