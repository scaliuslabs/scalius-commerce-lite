// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { ContextualSaveBar } from "./ContextualSaveBar";

const router = vi.hoisted(() => ({ useBlocker: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useBlocker: router.useBlocker }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ContextualSaveBar", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onSave: Mock<() => void>;
  let onDiscard: Mock<() => void>;

  beforeEach(() => {
    vi.resetAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    onSave = vi.fn<() => void>();
    onDiscard = vi.fn<() => void>();
    router.useBlocker.mockReturnValue({ status: "idle", proceed: vi.fn(), reset: vi.fn() });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function render(ui: ReactNode) {
    await act(async () => {
      root.render(ui);
    });
  }

  function bar() {
    return host.querySelector<HTMLElement>('[data-testid="contextual-save-bar"]');
  }
  function button(label: string) {
    return Array.from(host.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === label,
    );
  }

  it("stays hidden until the form is dirty", async () => {
    await render(<ContextualSaveBar isDirty={false} onSave={onSave} onDiscard={onDiscard} />);
    expect(bar()).toBeNull();
    expect(button("Save")).toBeUndefined();

    await render(<ContextualSaveBar isDirty onSave={onSave} onDiscard={onDiscard} />);
    expect(bar()).not.toBeNull();
  });

  it("announces itself politely and labels the unsaved state", async () => {
    await render(<ContextualSaveBar isDirty onSave={onSave} onDiscard={onDiscard} />);

    expect(bar()!.getAttribute("role")).toBe("status");
    expect(bar()!.getAttribute("aria-live")).toBe("polite");
    expect(bar()!.textContent).toContain("Unsaved changes");
  });

  it("runs Save and Discard through the caller", async () => {
    await render(<ContextualSaveBar isDirty onSave={onSave} onDiscard={onDiscard} />);

    await act(async () => button("Discard")!.click());
    expect(onDiscard).toHaveBeenCalledTimes(1);

    await act(async () => button("Save")!.click());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("disables Save while the draft is invalid and explains why", async () => {
    await render(
      <ContextualSaveBar
        isDirty
        onSave={onSave}
        onDiscard={onDiscard}
        saveDisabled
        saveDisabledReason="Fix the highlighted fields"
      />,
    );

    const save = button("Save")!;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("title")).toBe("Fix the highlighted fields");
    await act(async () => save.click());
    expect(onSave).not.toHaveBeenCalled();
    // Discarding an invalid draft must stay possible.
    expect(button("Discard")!.disabled).toBe(false);
  });

  it("locks both actions while a save is in flight", async () => {
    await render(<ContextualSaveBar isDirty saving onSave={onSave} onDiscard={onDiscard} />);

    expect(bar()!.getAttribute("aria-busy")).toBe("true");
    expect(button("Saving")!.disabled).toBe(true);
    expect(button("Discard")!.disabled).toBe(true);
    expect(host.querySelector(".animate-spin")).not.toBeNull();
  });

  it("locks both actions for an operator who may not edit", async () => {
    await render(
      <ContextualSaveBar isDirty canSave={false} onSave={onSave} onDiscard={onDiscard} />,
    );

    expect(button("Save")!.disabled).toBe(true);
    expect(button("Discard")!.disabled).toBe(true);
  });

  it("drops Discard when there is no earlier version to restore", async () => {
    await render(
      <ContextualSaveBar
        isDirty
        hideDiscard
        saveLabel="Publish"
        message="This menu is not published yet"
        onSave={onSave}
        onDiscard={onDiscard}
      />,
    );

    expect(host.querySelector('[data-testid="contextual-save-bar-discard"]')).toBeNull();
    const save = host.querySelector<HTMLButtonElement>(
      '[data-testid="contextual-save-bar-save"]',
    )!;
    expect(save.textContent).toContain("Publish");
    await act(async () => save.click());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("can offer Discard while it is not yet available", async () => {
    await render(
      <ContextualSaveBar
        isDirty
        discardDisabled
        onSave={onSave}
        onDiscard={onDiscard}
      />,
    );

    expect(button("Discard")!.disabled).toBe(true);
    await act(async () => button("Discard")!.click());
    expect(onDiscard).not.toHaveBeenCalled();
    // Only Discard is held back; saving stays available.
    expect(button("Save")!.disabled).toBe(false);
  });

  it("uses the custom labels and message", async () => {
    await render(
      <ContextualSaveBar
        isDirty
        onSave={onSave}
        onDiscard={onDiscard}
        message="Unsaved platform origins"
        saveLabel="Save platform"
        discardLabel="Reset"
      />,
    );

    expect(bar()!.textContent).toContain("Unsaved platform origins");
    expect(button("Save platform")).toBeDefined();
    expect(button("Reset")).toBeDefined();
  });

  it("arms navigation blocking only while it is mounted and dirty", async () => {
    await render(<ContextualSaveBar isDirty onSave={onSave} onDiscard={onDiscard} />);
    const opts = router.useBlocker.mock.calls.at(-1)![0] as {
      disabled?: boolean;
      enableBeforeUnload?: boolean;
    };
    expect(opts.disabled).toBe(false);
    expect(opts.enableBeforeUnload).toBe(false);

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("skips the blocker entirely when navigation blocking is turned off", async () => {
    await render(
      <ContextualSaveBar isDirty blockNavigation={false} onSave={onSave} onDiscard={onDiscard} />,
    );

    const opts = router.useBlocker.mock.calls.at(-1)![0] as { disabled?: boolean };
    expect(opts.disabled).toBe(true);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("asks before leaving once the router parks a navigation", async () => {
    const proceed = vi.fn();
    const reset = vi.fn();
    router.useBlocker.mockReturnValue({ status: "blocked", proceed, reset });
    await render(<ContextualSaveBar isDirty onSave={onSave} onDiscard={onDiscard} />);

    // The dialog renders in a portal outside the test host.
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Leave without saving?");

    const discardChanges = Array.from(dialog.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === "Discard changes",
    )!;
    await act(async () => discardChanges.click());
    expect(proceed).toHaveBeenCalledTimes(1);
  });
});
