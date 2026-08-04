// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NON_CRITICAL_ANALYTICS_DELAY_MS,
  scheduleNonCriticalAnalytics,
} from "./non-critical-analytics";

describe("non-critical analytics scheduling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps passive analytics outside the initial rendering window", () => {
    vi.useFakeTimers();
    const task = vi.fn();

    scheduleNonCriticalAnalytics(task);
    vi.advanceTimersByTime(NON_CRITICAL_ANALYTICS_DELAY_MS - 1);
    expect(task).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledOnce();
  });

  it("releases analytics once on real buyer interaction", () => {
    vi.useFakeTimers();
    const task = vi.fn();

    scheduleNonCriticalAnalytics(task);
    window.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(NON_CRITICAL_ANALYTICS_DELAY_MS);

    expect(task).toHaveBeenCalledOnce();
  });
});
