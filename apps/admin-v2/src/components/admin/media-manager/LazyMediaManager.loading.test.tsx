// @vitest-environment happy-dom

// The picker's code downloads on first use. A click on a freshly loaded page
// must be answered at once (a loading dialog), never silently.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaManager } from "./LazyMediaManager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const gate = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
});

vi.mock("./MediaManager", async () => {
  await gate.promise;
  return { MediaManager: () => createElement("div", { "data-testid": "picker" }, "picker ready") };
});

describe("the media picker's first click", () => {
  let host: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("opens a loading dialog while the code arrives, then the picker", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(
      <MediaManager capability="both" trigger={<button type="button">Add media</button>} onSelect={vi.fn()} />,
    ));
    await act(async () => host.querySelector("button")!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="picker"]')).toBeNull();
    await act(async () => { gate.release(); await gate.promise; });
    expect(document.querySelector('[data-testid="picker"]')).not.toBeNull();
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});
