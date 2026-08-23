// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_NAVIGATION_PROGRESS_DELAY_MS,
  ADMIN_NAVIGATION_PROGRESS_MIN_VISIBLE_MS,
  AdminNavigationProgressView,
} from "./AdminNavigationProgress";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AdminNavigationProgress", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  function render(active: boolean) {
    act(() => root.render(<AdminNavigationProgressView active={active} />));
  }

  function progressElement() {
    return host.querySelector("[data-admin-navigation-progress]");
  }

  it("does not flash for a fast navigation", () => {
    render(true);
    act(() => vi.advanceTimersByTime(ADMIN_NAVIGATION_PROGRESS_DELAY_MS - 1));
    expect(progressElement()).toBeNull();

    render(false);
    act(() => vi.advanceTimersByTime(ADMIN_NAVIGATION_PROGRESS_DELAY_MS));
    expect(progressElement()).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("");
  });

  it("shows restrained, accessible progress for a slow navigation", () => {
    render(true);
    expect(progressElement()).toBeNull();

    act(() => vi.advanceTimersByTime(ADMIN_NAVIGATION_PROGRESS_DELAY_MS));

    const progress = progressElement();
    expect(progress).not.toBeNull();
    expect(progress?.getAttribute("aria-hidden")).toBe("true");
    expect(progress?.firstElementChild?.className).toContain(
      "motion-reduce:animate-none",
    );
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Loading next page",
    );
  });

  it("does not block completion and avoids a one-frame progress flash", () => {
    render(true);
    act(() => vi.advanceTimersByTime(ADMIN_NAVIGATION_PROGRESS_DELAY_MS));
    expect(progressElement()).not.toBeNull();

    render(false);
    act(() =>
      vi.advanceTimersByTime(ADMIN_NAVIGATION_PROGRESS_MIN_VISIBLE_MS - 1),
    );
    expect(progressElement()).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(progressElement()).toBeNull();
  });
});
