// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useUnsavedChanges,
  type UnsavedChangesState,
  type UseUnsavedChangesOptions,
} from "./useUnsavedChanges";

const router = vi.hoisted(() => ({ useBlocker: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useBlocker: router.useBlocker }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type BlockerOpts = {
  shouldBlockFn: (args: {
    current: { routeId: string; fullPath: string; pathname: string };
    next: { routeId: string; fullPath: string; pathname: string };
  }) => boolean;
  enableBeforeUnload?: boolean;
  disabled?: boolean;
  withResolver?: boolean;
};

function location(pathname: string, routeId = pathname) {
  return { routeId, fullPath: pathname, pathname };
}

describe("useUnsavedChanges", () => {
  let host: HTMLDivElement;
  let root: Root;
  let state: UnsavedChangesState | null;
  let proceed: ReturnType<typeof vi.fn>;
  let reset: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    state = null;
    proceed = vi.fn();
    reset = vi.fn();
    router.useBlocker.mockReturnValue({ status: "idle", proceed, reset });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function Probe({ isDirty, ...options }: { isDirty: boolean } & UseUnsavedChangesOptions) {
    state = useUnsavedChanges(isDirty, options);
    return null;
  }

  async function render(ui: ReactNode) {
    await act(async () => {
      root.render(ui);
    });
  }

  function blockerOpts(): BlockerOpts {
    return router.useBlocker.mock.calls.at(-1)![0] as BlockerOpts;
  }

  it("arms the router blocker only while the form is dirty", async () => {
    await render(<Probe isDirty={false} />);
    expect(blockerOpts().disabled).toBe(true);
    expect(blockerOpts().withResolver).toBe(true);
    expect(state!.isBlocking).toBe(false);
    expect(blockerOpts().shouldBlockFn({ current: location("/a"), next: location("/b") })).toBe(
      false,
    );

    await render(<Probe isDirty />);
    expect(blockerOpts().disabled).toBe(false);
    expect(state!.isBlocking).toBe(true);
    expect(blockerOpts().shouldBlockFn({ current: location("/a"), next: location("/b") })).toBe(
      true,
    );
  });

  it("does not block while a save is in flight or when disabled", async () => {
    await render(<Probe isDirty isSubmitting />);
    expect(state!.isBlocking).toBe(false);
    expect(blockerOpts().disabled).toBe(true);

    await render(<Probe isDirty disabled />);
    expect(state!.isBlocking).toBe(false);
    expect(blockerOpts().disabled).toBe(true);
  });

  it("lets same-route query-state navigation through when allowed", async () => {
    await render(<Probe isDirty allowSamePathNavigation />);
    const { shouldBlockFn } = blockerOpts();

    expect(
      shouldBlockFn({
        current: { routeId: "/admin/settings", fullPath: "/admin/settings", pathname: "/admin/settings" },
        next: { routeId: "/admin/settings", fullPath: "/admin/settings", pathname: "/admin/settings/" },
      }),
    ).toBe(false);
    expect(
      shouldBlockFn({ current: location("/admin/settings"), next: location("/admin/orders") }),
    ).toBe(true);
  });

  it("owns the beforeunload prompt instead of the blocker, and removes it when clean", async () => {
    await render(<Probe isDirty />);
    expect(blockerOpts().enableBeforeUnload).toBe(false);

    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    await render(<Probe isDirty={false} />);
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });

  it("exposes the resolver and releases a parked navigation once the form is clean", async () => {
    router.useBlocker.mockReturnValue({ status: "blocked", proceed, reset });
    await render(<Probe isDirty />);
    expect(state!.status).toBe("blocked");
    state!.proceed();
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();

    // Saving from the dialog clears the form: the parked navigation must not
    // be left hanging.
    await render(<Probe isDirty={false} />);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("never throws when the blocker has no resolver", async () => {
    router.useBlocker.mockReturnValue(undefined);
    await render(<Probe isDirty />);
    expect(state!.status).toBe("idle");
    expect(() => {
      state!.proceed();
      state!.reset();
    }).not.toThrow();
  });
});
