// @vitest-environment happy-dom
/**
 * A centred modal keeps its top edge while it is open: it opens where its first
 * content centres it, then grows and shrinks downward, so a filtered list, a
 * chip row or an error line never moves the dialog (or the buttons in it).
 * happy-dom has no layout, so the panel's height and the viewport are stubbed.
 */
import React, { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "./alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PANEL = '[data-slot="dialog-content"], [role="alertdialog"]';

describe("modal top anchor", () => {
  let host: HTMLDivElement;
  let root: Root;
  let viewport: { width: number; height: number };
  let panelHeight: number;
  let measured: number;
  const matchMedia = window.matchMedia;
  const innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");

  beforeEach(() => {
    viewport = { width: 1024, height: 800 };
    panelHeight = 300;
    measured = 0;
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => viewport.height });
    window.matchMedia = ((query: string) => ({
      matches: query === "(min-width: 40rem)" && viewport.width >= 640,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const panel = this.matches(PANEL);
      if (panel) measured += 1;
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: panel ? panelHeight : 0, toJSON: () => ({}) };
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    window.matchMedia = matchMedia;
    if (innerHeight) Object.defineProperty(window, "innerHeight", innerHeight);
  });

  const panel = () => document.querySelector<HTMLElement>(PANEL);
  const top = () => panel()?.style.getPropertyValue("--dialog-top");
  const resize = (next: Partial<typeof viewport>) => {
    viewport = { ...viewport, ...next };
    act(() => { window.dispatchEvent(new Event("resize")); });
  };

  function Harness({ open = true, variant, extra = false }: { open?: boolean; variant?: "modal" | "palette"; extra?: boolean }) {
    return (
      <Dialog open={open} onOpenChange={() => {}}>
        <DialogContent variant={variant}>
          <DialogTitle>Add market</DialogTitle>
          <DialogDescription>Pick countries.</DialogDescription>
          {extra ? <p>A chip row appeared</p> : null}
        </DialogContent>
      </Dialog>
    );
  }
  const render = (element: React.ReactElement) => act(async () => root.render(element));

  it("pins the top edge where the first content centres the dialog, before the first paint", async () => {
    await render(<Harness />);
    expect(top()).toBe("max(1rem, 250px)");
    expect(panel()?.hasAttribute("data-anchored")).toBe(true);
  });

  it("keeps the top when the content changes height while open", async () => {
    await render(<Harness />);
    const before = measured;
    panelHeight = 620;
    await render(<Harness extra />);
    expect(document.body.textContent).toContain("A chip row appeared");
    expect(top()).toBe("max(1rem, 250px)");
    // No re-measure: the position was decided once.
    expect(measured).toBe(before);
  });

  it("keeps the top across re-renders that touch the dialog's own state", async () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <Dialog open onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>Count</DialogTitle>
            <DialogDescription>Counter.</DialogDescription>
            <button type="button" onClick={() => setCount(count + 1)}>{count}</button>
          </DialogContent>
        </Dialog>
      );
    }
    await render(<Counter />);
    panelHeight = 700;
    await act(async () => document.querySelector<HTMLButtonElement>("button:not([class])")!.click());
    expect(top()).toBe("max(1rem, 250px)");
  });

  it("lifts the panel, never lowers it, when loaded content outgrows the room below its top", async () => {
    const watchers: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { watchers.push(callback); }
      observe() {}
      disconnect() {}
    });
    const box = { scroll: 300, client: 300 };
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.matches(PANEL) ? box.scroll : 0; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.matches(PANEL) ? box.client : 0; });
    await render(<Harness />);
    expect(top()).toBe("max(1rem, 250px)");
    const changed = () => act(() => { for (const watcher of watchers) watcher(); });
    // A list loads: 620px of content, but the cap from a 250px top leaves 534px.
    box.scroll = 620;
    box.client = 534;
    changed();
    expect(top()).toBe("max(1rem, 90px)");
    // It shrinks again: the panel stays where it is.
    box.scroll = 400;
    box.client = 400;
    changed();
    expect(top()).toBe("max(1rem, 90px)");
    // Content that fits under the pinned top never moves it.
    box.scroll = 500;
    box.client = 500;
    changed();
    expect(top()).toBe("max(1rem, 90px)");
    vi.unstubAllGlobals();
  });

  it("measures again on every open", async () => {
    await render(<Harness />);
    expect(top()).toBe("max(1rem, 250px)");
    await render(<Harness open={false} />);
    expect(panel()).toBeNull();
    panelHeight = 500;
    await render(<Harness />);
    expect(top()).toBe("max(1rem, 150px)");
  });

  it("never sits nearer than 1rem to the top, and lets the height cap scroll a taller panel", async () => {
    panelHeight = 900;
    await render(<Harness />);
    expect(top()).toBe("max(1rem, -50px)");
    // The cap stops 1rem above the bottom edge, measured from the pinned top.
    expect(panel()?.className).toContain("max-h-[calc(100dvh-var(--dialog-top,0px)-1rem)]");
    expect(panel()?.className).toContain("overflow-y-auto");
  });

  it("re-anchors for the current content when the window is resized", async () => {
    await render(<Harness />);
    panelHeight = 400;
    resize({ height: 600 });
    expect(top()).toBe("max(1rem, 100px)");
  });

  it("leaves a phone's bottom sheet alone, including after a resize", async () => {
    viewport.width = 390;
    await render(<Harness />);
    expect(panel()?.hasAttribute("data-anchored")).toBe(false);
    expect(top()).toBe("");
    expect(panel()?.className).toContain("bottom-0");
    resize({ height: 700 });
    expect(top()).toBe("");
    // Widening to a tablet turns it into a centred, anchored dialog; narrowing releases it.
    resize({ width: 900 });
    expect(top()).toBe("max(1rem, 200px)");
    resize({ width: 390 });
    expect(panel()?.hasAttribute("data-anchored")).toBe(false);
    expect(top()).toBe("");
  });

  it("leaves the command palette alone: it is already anchored under the top bar", async () => {
    await render(<Harness variant="palette" />);
    expect(panel()?.hasAttribute("data-anchored")).toBe(false);
    expect(top()).toBe("");
    expect(measured).toBe(0);
  });

  it("anchors an alert dialog the same way", async () => {
    await render(
      <AlertDialog open onOpenChange={() => {}}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete it?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expect(top()).toBe("max(1rem, 250px)");
    expect(panel()?.hasAttribute("data-anchored")).toBe(true);
  });

  it("forwards the caller's ref to the panel", async () => {
    const ref = createRef<HTMLDivElement>();
    await render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent ref={ref}>
          <DialogTitle>Ref</DialogTitle>
          <DialogDescription>Ref.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(ref.current).toBe(panel());
  });

  it("lets a dialog that sets its own max-height keep it", async () => {
    await render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent className="max-h-[860px]">
          <DialogTitle>Media</DialogTitle>
          <DialogDescription>Media.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(panel()?.className).toContain("max-h-[860px]");
    expect(panel()?.className).not.toContain("--dialog-top,0px");
  });
  it("returns focus to a plain opener when Escape closes a controlled dialog", async () => {
    function PlainOpener() {
      const [open, setOpen] = useState(false);
      return <>
        <button onClick={() => setOpen(true)}>Import</button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Import products</DialogTitle>
            <DialogDescription>Choose a file.</DialogDescription>
            <button>Choose file</button>
          </DialogContent>
        </Dialog>
      </>;
    }
    await render(<PlainOpener />);
    const opener = host.querySelector("button")!;
    opener.focus();
    await act(async () => opener.click());
    expect(panel()).not.toBeNull();
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    expect(panel()).toBeNull();
    expect(host.inert).not.toBe(true);
  });

});
