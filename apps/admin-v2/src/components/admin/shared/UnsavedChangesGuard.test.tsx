// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proceed: vi.fn(),
  reset: vi.fn(),
  useBlocker: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useBlocker: mocks.useBlocker,
}));

import { UnsavedChangesGuard } from "./UnsavedChangesGuard";
import { ADMIN_NAVIGATION_CANCELLED_EVENT } from "./admin-navigation-events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("UnsavedChangesGuard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.proceed.mockReset();
    mocks.reset.mockReset();
    mocks.useBlocker.mockReset();
    mocks.useBlocker.mockReturnValue({
      status: "blocked",
      proceed: mocks.proceed,
      reset: mocks.reset,
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
  });

  it("announces Keep Editing as a cancelled guarded navigation", async () => {
    const cancelled = vi.fn();
    window.addEventListener(ADMIN_NAVIGATION_CANCELLED_EVENT, cancelled);

    await act(async () => {
      root.render(
        <UnsavedChangesGuard isDirty={true} isSubmitting={false} />,
      );
    });

    const keepEditing = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Keep Editing",
    );
    expect(keepEditing).toBeTruthy();

    await act(async () => {
      keepEditing?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(mocks.reset).toHaveBeenCalled();
    expect(mocks.proceed).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledTimes(1);

    window.removeEventListener(ADMIN_NAVIGATION_CANCELLED_EVENT, cancelled);
  });

  it("proceeds through the guard without announcing a cancellation", async () => {
    const cancelled = vi.fn();
    window.addEventListener(ADMIN_NAVIGATION_CANCELLED_EVENT, cancelled);

    await act(async () => {
      root.render(
        <UnsavedChangesGuard isDirty={true} isSubmitting={false} />,
      );
    });

    const discardChanges = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Discard Changes",
    );
    expect(discardChanges).toBeTruthy();

    await act(async () => {
      discardChanges?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(mocks.proceed).toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();

    window.removeEventListener(ADMIN_NAVIGATION_CANCELLED_EVENT, cancelled);
  });

  it("allows route-backed state changes on the same form pathname", async () => {
    await act(async () => {
      root.render(
        <UnsavedChangesGuard
          isDirty={true}
          isSubmitting={false}
          allowSamePathStateNavigation={true}
        />,
      );
    });

    const options = mocks.useBlocker.mock.calls.at(-1)?.[0];
    expect(options.shouldBlockFn({
      action: "PUSH",
      current: {
        routeId: "/admin/analytics/new",
        fullPath: "/admin/analytics/new",
        pathname: "/admin/analytics/new",
      },
      next: {
        routeId: "/admin/analytics/new",
        fullPath: "/admin/analytics/new",
        pathname: "/admin/analytics/new/",
      },
    })).toBe(false);
    expect(options.shouldBlockFn({
      action: "PUSH",
      current: {
        routeId: "/admin/analytics/new",
        fullPath: "/admin/analytics/new",
        pathname: "/admin/analytics/new",
      },
      next: {
        routeId: "/admin/analytics",
        fullPath: "/admin/analytics",
        pathname: "/admin/analytics",
      },
    })).toBe(true);
  });

  it("cancels a blocked navigation when saving leaves no unsaved work", async () => {
    const cancelled = vi.fn();
    window.addEventListener(ADMIN_NAVIGATION_CANCELLED_EVENT, cancelled);
    await act(async () => {
      root.render(<UnsavedChangesGuard isDirty={true} isSubmitting={false} />);
    });
    expect(mocks.reset).not.toHaveBeenCalled();
    await act(async () => {
      root.render(<UnsavedChangesGuard isDirty={false} isSubmitting={false} />);
    });
    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(mocks.proceed).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(mocks.useBlocker.mock.calls.at(-1)?.[0].enableBeforeUnload).toBe(false);
    window.removeEventListener(ADMIN_NAVIGATION_CANCELLED_EVENT, cancelled);
  });

  it.each([
    { enabled: [false, false], internalBlocks: [true, true] },
    { enabled: [true, true], internalBlocks: [false, false] },
    { enabled: [true, false], internalBlocks: [false, true] },
  ])("checks each retained guard with same-path opt-ins $enabled", async ({ enabled, internalBlocks }) => {
    mocks.useBlocker.mockReturnValue({ status: "idle" });
    await act(async () => {
      root.render(<>
        <UnsavedChangesGuard isDirty={true} isSubmitting={false} allowSamePathStateNavigation={enabled[0]} />
        <div hidden>
          <UnsavedChangesGuard isDirty={true} isSubmitting={false} allowSamePathStateNavigation={enabled[1]} />
        </div>
      </>);
    });
    const current = {
      routeId: "/admin/settings/", fullPath: "/admin/settings/", pathname: "/admin/settings",
      search: { section: "countries" },
    };
    expect(mocks.useBlocker).toHaveBeenCalledTimes(2);
    const guards = mocks.useBlocker.mock.calls.map(([options]) => options);
    expect(guards.map((guard) => guard.shouldBlockFn({
      current, next: { ...current, search: { section: "business" } },
    }))).toEqual(internalBlocks);
    for (const guard of guards) {
      expect(guard.shouldBlockFn({
        current,
        next: { routeId: "/admin/orders/", fullPath: "/admin/orders/", pathname: "/admin/orders" },
      })).toBe(true);
      expect(guard.enableBeforeUnload).toBe(true);
    }
  });

  it.each([
    { isDirty: true, isSubmitting: false, blocks: true },
    { isDirty: false, isSubmitting: false, blocks: false },
    { isDirty: true, isSubmitting: true, blocks: false },
    { isDirty: false, isSubmitting: true, blocks: false },
  ])("keeps route and beforeunload policy aligned for $isDirty/$isSubmitting", async ({ isDirty, isSubmitting, blocks }) => {
    mocks.useBlocker.mockReturnValue({ status: "idle" });
    await act(async () => {
      root.render(<UnsavedChangesGuard isDirty={isDirty} isSubmitting={isSubmitting} />);
    });
    const options = mocks.useBlocker.mock.calls.at(-1)?.[0];
    expect(options.enableBeforeUnload).toBe(blocks);
    expect(options.shouldBlockFn({
      current: { pathname: "/admin/settings" },
      next: { pathname: "/admin/orders" },
    })).toBe(blocks);
    expect(mocks.reset).not.toHaveBeenCalled();
  });
});
