// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORDER_AUTO_REFRESH_SECONDS, useOrderAutoRefresh } from "./use-order-auto-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let toggle: () => void = () => {};

function Harness({ refetch, paused }: { refetch: () => Promise<unknown>; paused: boolean }) {
  const autoRefresh = useOrderAutoRefresh({ refetch, isFetching: false, paused });
  toggle = autoRefresh.toggle;
  return <span>{autoRefresh.enabled ? "on" : "off"}</span>;
}

describe("useOrderAutoRefresh", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("stays off until switched on, then refreshes once a minute and remembers the choice", async () => {
    const refetch = vi.fn(async () => undefined);
    act(() => root.render(<Harness refetch={refetch} paused={false} />));
    act(() => vi.advanceTimersByTime(ORDER_AUTO_REFRESH_SECONDS * 1_000));
    expect(refetch).not.toHaveBeenCalled();

    await act(async () => toggle());
    expect(host.textContent).toBe("on");
    expect(localStorage.getItem("orderlist-auto-refresh")).toBe("true");
    expect(refetch).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(ORDER_AUTO_REFRESH_SECONDS * 1_000));
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("does not refresh while paused and keeps the elapsed time", () => {
    localStorage.setItem("orderlist-auto-refresh", "true");
    const refetch = vi.fn(async () => undefined);
    act(() => root.render(<Harness refetch={refetch} paused={false} />));
    act(() => vi.advanceTimersByTime(30_000));
    act(() => root.render(<Harness refetch={refetch} paused />));
    act(() => vi.advanceTimersByTime(120_000));
    expect(refetch).not.toHaveBeenCalled();

    act(() => root.render(<Harness refetch={refetch} paused={false} />));
    act(() => vi.advanceTimersByTime(30_000));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("skips hidden ticks and refreshes when the tab becomes visible again", () => {
    localStorage.setItem("orderlist-auto-refresh", "true");
    let hidden = true;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const refetch = vi.fn(async () => undefined);
    act(() => root.render(<Harness refetch={refetch} paused={false} />));
    act(() => vi.advanceTimersByTime(120_000));
    expect(refetch).not.toHaveBeenCalled();

    hidden = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
