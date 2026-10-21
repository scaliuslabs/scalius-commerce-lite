// @vitest-environment happy-dom

// The picker's code downloads on first use. A click on a freshly loaded page
// must be answered at once (a loading dialog), never silently.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { MediaManager } from "./LazyMediaManager";

vi.mock("@tanstack/react-router", async (original) => ({ ...(await original<object>()), useBlocker: () => ({ status: "idle" }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const gate = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
});

vi.mock("./MediaManager", async () => {
  await gate.promise;
  const { DialogContent, DialogTitle } = await import("~/components/ui/dialog");
  return { MediaManager: ({ onCloseAutoFocus }: { onCloseAutoFocus?: (event: Event) => void }) =>
    createElement(DialogContent, { onCloseAutoFocus, "aria-describedby": undefined },
      createElement(DialogTitle, {}, "Picker ready"),
      createElement("button", { "data-testid": "picker" }, "Choose image")),
  };
});

describe("the media picker's first click", () => {
  let host: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  // The lazy module may still be loading when the test ends: let every
  // dynamic import settle before the environment is torn down.
  afterAll(async () => {
    gate.release();
    await vi.dynamicImportSettled();
  });

  it("opens a loading dialog while the code arrives, then the picker", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const onCloseAutoFocus = vi.fn();
    await act(async () => root.render(
      <MediaManager onCloseAutoFocus={onCloseAutoFocus} capability="both" trigger={<button type="button">Add media</button>} onSelect={vi.fn()} />,
    ));
    const trigger = host.querySelector("button")!;
    await act(async () => trigger.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="picker"]')).toBeNull();
    // Closing before the lazy module arrives restores the same real trigger.
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onCloseAutoFocus).toHaveBeenCalledOnce();
    onCloseAutoFocus.mockClear();
    await act(async () => trigger.click());
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => { gate.release(); await gate.promise; });
    expect(document.querySelector('[data-testid="picker"]')).not.toBeNull();
    expect(document.querySelector('[role="status"]')).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(onCloseAutoFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.querySelector('[data-testid="picker"]'));
  });
});
