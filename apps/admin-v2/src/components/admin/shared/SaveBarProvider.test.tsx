// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { SaveBarProvider, useSaveBar, type SaveBarEntry } from "./SaveBar";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({ useBlocker: () => ({ status: "idle" }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Card(entry: SaveBarEntry) {
  useSaveBar(entry);
  return null;
}

const pressSave = () =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
  });

describe("page save bar", () => {
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => act(() => root.unmount()));

  function render(entry: SaveBarEntry) {
    act(() => {
      root.render(
        <SaveBarProvider unsavedMessage="Unsaved customer" savedMessage="Customer created">
          <Card {...entry} />
        </SaveBarProvider>,
      );
    });
  }

  it("names a new record, saves on Ctrl/⌘+S and confirms with the record's own words", async () => {
    const entry = { dirty: true, save: vi.fn(async () => undefined), discard: vi.fn() };
    render(entry);
    expect(document.querySelector("[data-save-bar]")?.textContent).toContain("Unsaved customer");

    await pressSave();
    expect(entry.save).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith("Customer created");
  });

  it("ignores Ctrl/⌘+S when nothing changed", async () => {
    const entry = { dirty: false, save: vi.fn(async () => undefined), discard: vi.fn() };
    render(entry);
    expect(document.querySelector("[data-save-bar]")).toBeNull();

    await pressSave();
    expect(entry.save).not.toHaveBeenCalled();
  });
});
