// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { SaveBarProvider, SaveErrorBanner, useSaveBar, type SaveBarEntry } from "./SaveBar";

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

const barText = () => document.querySelector("[data-save-bar]")?.textContent ?? "";
const bannerButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("[role=alert] button")].find((button) => button.textContent === label);
const pressBarSave = () =>
  act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>("[data-save-bar] button")].find((button) => button.textContent === "Save")!.click();
  });

describe("page save bar", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(entry: SaveBarEntry) {
    act(() => {
      root.render(
        <SaveBarProvider unsavedLabel="Unsaved customer" savedMessage="Customer created">
          <SaveErrorBanner />
          <Card {...entry} />
        </SaveBarProvider>,
      );
    });
  }

  it("says an unreachable server can be retried, and Retry in the banner saves again", async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("Failed to fetch"), { name: "TypeError" }))
      .mockResolvedValueOnce(undefined);
    render({ dirty: true, label: "Checkout", save, discard: vi.fn() });

    await pressBarSave();
    expect(barText()).toContain("Couldn't save · Retry");
    expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't reach the server");

    await act(async () => bannerButton("Retry")!.click());
    expect(save).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Customer created");
  });

  it("treats a server fault like a connection problem", async () => {
    render({ dirty: true, save: vi.fn(async () => { throw new AdminApiResponseError("API error: 502", 502); }), discard: vi.fn() });

    await pressBarSave();
    expect(barText()).toContain("Couldn't save · Retry");
    expect(bannerButton("Retry")).toBeDefined();
  });

  it("says someone else changed it and offers the reload that keeps the edits", async () => {
    const reload = vi.fn(async () => undefined);
    const conflict = new AdminApiResponseError("Changed", 409, "SETTINGS_REVISION_CONFLICT", {
      document: "checkout",
      expectedRevision: 3,
      currentRevision: 4,
    });
    render({ dirty: true, save: vi.fn(async () => { throw conflict; }), discard: vi.fn(), reload });

    await pressBarSave();
    expect(barText()).toContain("Changed by someone else · Reload");
    expect(bannerButton("Retry")).toBeUndefined();

    await act(async () => bannerButton("Reload and keep my edits")!.click());
    expect(reload).toHaveBeenCalledOnce();
    expect(barText()).toContain("Unsaved customer");
  });

  it("asks for a fix only when the server refused the input", async () => {
    render({ dirty: true, save: vi.fn(async () => { throw new AdminApiResponseError("Enter a whole number of days.", 400); }), discard: vi.fn() });

    await pressBarSave();
    expect(barText()).toContain("Not saved. Fix the problems listed");
    expect(bannerButton("Retry")).toBeUndefined();
  });

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
