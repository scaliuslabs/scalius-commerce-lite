// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { translate } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";
import { SaveErrorBanner, SaveScope, useSaveBar, type SaveBarEntry, type SaveScopeState } from "./SaveBar";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Card(entry: SaveBarEntry) {
  useSaveBar(entry);
  return null;
}

describe("save scope", () => {
  let root: Root;
  let state: SaveScopeState | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => act(() => root.unmount()));

  function render(entries: SaveBarEntry[]) {
    act(() => {
      root.render(
        <SaveScope render={(next) => { state = next; return null; }}>
          {entries.map((entry, index) => <Card key={index} {...entry} />)}
        </SaveScope>,
      );
    });
  }

  it("saves only dirty cards and reports one success", async () => {
    const clean = { dirty: false, save: vi.fn(), discard: vi.fn() };
    const dirty = { dirty: true, save: vi.fn(async () => undefined), discard: vi.fn() };
    render([clean, dirty]);
    expect(state!.dirty).toBe(true);

    let saved = false;
    await act(async () => { saved = await state!.saveAll(); });
    expect(saved).toBe(true);
    expect(clean.save).not.toHaveBeenCalled();
    expect(dirty.save).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledOnce();
  });

  it("saves every dirty card, lists each failure and keeps the failed edits", async () => {
    const failing = {
      dirty: true,
      label: "Business details",
      save: vi.fn(async () => { throw new AdminApiResponseError("Enter a valid phone number.", 400); }),
      discard: vi.fn(),
    };
    const crashed = { dirty: true, save: vi.fn(async () => { throw new AdminApiResponseError("API error: 500", 500); }), discard: vi.fn() };
    const later = { dirty: true, save: vi.fn(async () => undefined), discard: vi.fn() };
    render([failing, crashed, later]);

    let saved = true;
    await act(async () => { saved = await state!.saveAll(); });
    expect(saved).toBe(false);
    expect(later.save).toHaveBeenCalledOnce();
    expect(toast.success).not.toHaveBeenCalled();
    expect(state!.errors).toEqual([
      "Business details: Enter a valid phone number.",
      translate(saveBarMessages, "serverError"),
    ]);
    expect(failing.discard).not.toHaveBeenCalled();
  });

  it("shows the problems in a banner and moves focus to the first invalid field", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const bannerRoot = createRoot(container);
    let scope: SaveScopeState | null = null;
    const entry = { dirty: true, save: vi.fn(async () => { throw new Error("Pick a role."); }), discard: vi.fn() };
    act(() => {
      bannerRoot.render(
        <SaveScope render={(next) => { scope = next; return null; }}>
          <SaveErrorBanner />
          <input aria-invalid="true" data-testid="field" />
          <Card {...entry} />
        </SaveScope>,
      );
    });
    expect(container.querySelector("[role=alert]")).toBeNull();

    await act(async () => { await scope!.saveAll(); });
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Pick a role.");
    expect(document.activeElement).toBe(container.querySelector("[data-testid=field]"));

    act(() => scope!.discardAll());
    expect(container.querySelector("[role=alert]")).toBeNull();
    act(() => bannerRoot.unmount());
    container.remove();
  });

  it("won't save while a dirty card is invalid, and discards every dirty card", async () => {
    const invalid = { dirty: true, invalid: true, save: vi.fn(), discard: vi.fn() };
    const clean = { dirty: false, invalid: true, save: vi.fn(), discard: vi.fn() };
    const valid = { dirty: true, save: vi.fn(), discard: vi.fn() };
    render([invalid, clean, valid]);
    expect(state!.invalid).toBe(true);

    // Save shows what to fix instead of saving anything.
    let saved = true;
    await act(async () => { saved = await state!.saveAll(); });
    expect(saved).toBe(false);
    expect(invalid.save).not.toHaveBeenCalled();
    expect(valid.save).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();

    act(() => state!.discardAll());
    expect(invalid.discard).toHaveBeenCalledOnce();
    expect(clean.discard).not.toHaveBeenCalled();
  });
});
