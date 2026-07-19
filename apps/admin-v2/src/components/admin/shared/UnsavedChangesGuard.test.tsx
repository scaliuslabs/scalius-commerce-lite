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
});
