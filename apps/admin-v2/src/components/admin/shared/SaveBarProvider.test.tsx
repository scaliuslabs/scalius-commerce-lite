// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { SaveBarProvider, SaveConflict, SaveErrorBanner, useSaveBar, type SaveBarEntry } from "./SaveBar";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const navigation = vi.hoisted(() => ({ options: undefined as undefined | { shouldBlockFn: (location: { current: object; next: object }) => boolean; enableBeforeUnload: boolean } }));
vi.mock("@tanstack/react-router", () => ({ useBlocker: (options: typeof navigation.options) => { navigation.options = options; return { status: "idle" }; } }));

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

  it("leaves focus alone on a page's first render, and returns it to the page quietly after a save", async () => {
    const page = document.createElement("main");
    page.id = "admin-main-scroll";
    page.tabIndex = 0;
    document.body.append(page);
    const frame = () => act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    // A direct load: nothing moved focus, so the page must not take it (and draw its ring).
    render({ dirty: false, save: vi.fn(), discard: vi.fn() });
    await frame();
    expect(document.activeElement).toBe(document.body);

    // Edited, then saved from the bar: focus comes back to the page, marked as code's doing.
    render({ dirty: true, save: vi.fn(async () => undefined), discard: vi.fn() });
    await pressBarSave();
    render({ dirty: false, save: vi.fn(), discard: vi.fn() });
    (document.activeElement as HTMLElement | null)?.blur();
    await frame();
    expect(document.activeElement).toBe(page);
    expect(page.hasAttribute("data-quiet-focus")).toBe(true);
    // Once it leaves, a later Tab back draws the ring as usual.
    page.blur();
    expect(page.hasAttribute("data-quiet-focus")).toBe(false);
    page.remove();
  });

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

  it("offline, says the edits wait for the connection instead of asking for a fix (R6)", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    // A form that wraps the failure in its own words still reads as offline.
    render({ dirty: true, save: vi.fn(async () => { throw new Error("Couldn't save the checkout"); }), discard: vi.fn() });

    await pressBarSave();
    expect(barText()).toContain("You're offline · Save when you reconnect");
    expect(barText()).not.toContain("Fix the problems");
    onLine.mockRestore();
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

  it.each([
    new TypeError("Failed to fetch"),
    new SaveConflict("Keep my draft"),
  ])("keeps a rejected conflict reload retryable without an unhandled rejection", async (reloadFailure) => {
    const reload = vi.fn().mockRejectedValue(reloadFailure);
    const save = vi.fn().mockRejectedValue(new SaveConflict("Changed by someone else"));
    render({ dirty: true, save, discard: vi.fn(), reload });
    await pressBarSave();
    await act(async () => bannerButton("Reload and keep my edits")!.click());
    expect(reload).toHaveBeenCalledOnce();
    expect(bannerButton("Reload and keep my edits")?.disabled).toBe(false);
    expect(barText()).toContain("Changed by someone else · Reload");
    expect(save).toHaveBeenCalledOnce();
    expect(toast.error).not.toHaveBeenCalled();
    if (!(reloadFailure instanceof SaveConflict)) expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't reach the server");
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

  it("shows a new record's bar before any edit, and Save then checks what it still needs (P5)", async () => {
    const entry = { dirty: false, save: vi.fn(async () => undefined), discard: vi.fn() };
    render(entry);
    expect(barText()).toContain("Unsaved customer");
    const discard = [...document.querySelectorAll<HTMLButtonElement>("[data-save-bar] button")].find((button) => button.textContent === "Discard")!;
    expect(discard.disabled).toBe(true);

    await pressSave();
    expect(entry.save).toHaveBeenCalledTimes(1);
  });

  it("takes over the whole top bar and announces itself through a status line mounted before it appears", async () => {
    const topBar = document.createElement("header");
    topBar.id = "admin-top-bar";
    document.body.append(topBar);
    const status = () => container.querySelector("[role=status]");
    const draw = (dirty: boolean) =>
      act(() => {
        root.render(
          <SaveBarProvider savedMessage="Customer saved">
            <Card dirty={dirty} save={vi.fn(async () => undefined)} discard={vi.fn()} />
          </SaveBarProvider>,
        );
      });
    try {
      draw(false);
      const line = status();
      expect(line?.textContent).toBe("");
      draw(true);
      expect(topBar.querySelector(":scope > [data-save-bar]")).not.toBeNull();
      expect(status()).toBe(line);
      expect(line?.textContent).toBe("Unsaved changes");
      const labels = [...topBar.querySelectorAll("[data-save-bar] button")].map((button) => button.textContent);
      expect(labels).toEqual(["Discard", "Save"]);
      draw(false);
      expect(topBar.querySelector("[data-save-bar]")).toBeNull();
      expect(line?.textContent).toBe("");
    } finally {
      topBar.remove();
    }
  });

  it("ignores Ctrl/⌘+S when nothing changed on a saved record", async () => {
    const entry = { dirty: false, save: vi.fn(async () => undefined), discard: vi.fn() };
    act(() => {
      root.render(
        <SaveBarProvider savedMessage="Customer saved">
          <Card {...entry} />
        </SaveBarProvider>,
      );
    });
    expect(document.querySelector("[data-save-bar]")).toBeNull();

    await pressSave();
    expect(entry.save).not.toHaveBeenCalled();
  });
});


it("protects a retained revoked draft without showing save controls and restores the bar on regrant", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const save = vi.fn(), discard = vi.fn();
  const render = (dirty: boolean, navigationDirty?: boolean) => act(async () => root.render(
    <SaveBarProvider><Card dirty={dirty} navigationDirty={navigationDirty} save={save} discard={discard} /></SaveBarProvider>,
  ));
  try {
    await render(true);
    expect(document.querySelector("[data-save-bar]")).not.toBeNull();
    expect(navigation.options!.shouldBlockFn({ current: {}, next: {} })).toBe(true);
    await render(false, true);
    expect(document.querySelector("[data-save-bar]")).toBeNull();
    expect(navigation.options!.shouldBlockFn({ current: {}, next: {} })).toBe(true);
    expect(navigation.options!.enableBeforeUnload).toBe(true);
    await pressSave();
    expect(save).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
    await render(true, true);
    expect(document.querySelector("[data-save-bar]")).not.toBeNull();
    expect(navigation.options!.shouldBlockFn({ current: {}, next: {} })).toBe(true);
    await render(false);
    expect(navigation.options!.shouldBlockFn({ current: {}, next: {} })).toBe(false);
    expect(navigation.options!.enableBeforeUnload).toBe(false);
  } finally { act(() => root.unmount()); host.remove(); }
});
