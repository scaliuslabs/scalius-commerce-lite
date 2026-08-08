// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderAutoRefreshCountdown } from "./OrderAutoRefreshCountdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("OrderAutoRefreshCountdown", () => {
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
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("updates locally without rerendering its parent", () => {
    const onRefresh = vi.fn(() => true);
    let parentRenderCount = 0;

    function Harness() {
      parentRenderCount += 1;
      return (
        <OrderAutoRefreshCountdown paused={false} onRefresh={onRefresh} />
      );
    }

    act(() => root.render(<Harness />));
    expect(host.textContent).toBe("60s");

    act(() => vi.advanceTimersByTime(1_000));
    expect(host.textContent).toBe("59s");
    expect(parentRenderCount).toBe(1);

    act(() => vi.advanceTimersByTime(59_000));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(host.textContent).toBe("60s");
    expect(parentRenderCount).toBe(1);
  });

  it("invokes refresh once per cycle under Strict Mode", () => {
    const onRefresh = vi.fn(() => true);

    act(() =>
      root.render(
        <StrictMode>
          <OrderAutoRefreshCountdown paused={false} onRefresh={onRefresh} />
        </StrictMode>,
      ),
    );
    act(() => vi.advanceTimersByTime(60_000));

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(host.textContent).toBe("60s");
  });

  it("preserves the countdown while refresh is paused", () => {
    const onRefresh = vi.fn(() => true);

    act(() =>
      root.render(
        <OrderAutoRefreshCountdown paused={false} onRefresh={onRefresh} />,
      ),
    );
    act(() => vi.advanceTimersByTime(1_000));
    expect(host.textContent).toBe("59s");

    act(() =>
      root.render(
        <OrderAutoRefreshCountdown paused onRefresh={onRefresh} />,
      ),
    );
    act(() => vi.advanceTimersByTime(5_000));
    expect(host.textContent).toBe("Paused");
    expect(onRefresh).not.toHaveBeenCalled();

    act(() =>
      root.render(
        <OrderAutoRefreshCountdown paused={false} onRefresh={onRefresh} />,
      ),
    );
    expect(host.textContent).toBe("59s");
  });

  it("skips hidden ticks and refreshes once the page becomes visible", () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const onRefresh = vi.fn(() => true);

    act(() =>
      root.render(
        <OrderAutoRefreshCountdown paused={false} onRefresh={onRefresh} />,
      ),
    );
    act(() => vi.advanceTimersByTime(1_000));
    expect(host.textContent).toBe("59s");

    hidden = true;
    act(() => vi.advanceTimersByTime(5_000));
    expect(host.textContent).toBe("59s");
    expect(onRefresh).not.toHaveBeenCalled();

    hidden = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(host.textContent).toBe("60s");
  });
});
