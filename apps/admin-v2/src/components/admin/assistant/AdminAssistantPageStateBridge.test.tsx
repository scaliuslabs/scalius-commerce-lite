// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_ASSISTANT_PAGE_STATE_EVENT,
  registerAdminAssistantSurface,
  resetAdminAssistantPageStateForTest,
  type AdminAssistantPageStateSnapshot,
} from "./page-state";
import { AdminAssistantPageStateBridge } from "./AdminAssistantPageStateBridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function defineScrollMetrics(
  element: HTMLElement,
  metrics: { clientHeight: number; scrollHeight: number },
) {
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
}

describe("AdminAssistantPageStateBridge", () => {
  let root: Root;
  let host: HTMLDivElement;
  let scrollElement: HTMLDivElement;
  let events: AdminAssistantPageStateSnapshot[];
  let animationFrameCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    resetAdminAssistantPageStateForTest();
    document.body.innerHTML = "";
    document.title = "Customers alice@example.com +8801712345678";
    events = [];
    animationFrameCallbacks = [];

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
      animationFrameCallbacks[handle - 1] = () => undefined;
    });

    scrollElement = document.createElement("div");
    scrollElement.id = "admin-main-scroll";
    scrollElement.innerHTML = `
      <h1>Customer alice@example.com +8801712345678</h1>
      <input value="SuperSecret123!" />
      <textarea>Raw note that must not be read</textarea>
    `;
    defineScrollMetrics(scrollElement, {
      clientHeight: 500,
      scrollHeight: 1_500,
    });
    scrollElement.scrollTop = 300;
    document.body.append(scrollElement);

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    window.addEventListener(ADMIN_ASSISTANT_PAGE_STATE_EVENT, captureSnapshot);
  });

  afterEach(() => {
    window.removeEventListener(ADMIN_ASSISTANT_PAGE_STATE_EVENT, captureSnapshot);
    act(() => {
      root.unmount();
    });
    resetAdminAssistantPageStateForTest();
    vi.restoreAllMocks();
  });

  function captureSnapshot(event: Event) {
    events.push((event as CustomEvent<AdminAssistantPageStateSnapshot>).detail);
  }

  function flushAnimationFrame() {
    const callback = animationFrameCallbacks.shift();
    if (!callback) return;

    act(() => {
      callback(performance.now());
    });
  }

  it("publishes sanitized page metadata without reading field values", () => {
    act(() => {
      root.render(
        <AdminAssistantPageStateBridge routePath="/admin/customers/alice@example.com?token=chk_leak" />,
      );
    });
    flushAnimationFrame();

    const snapshot = window.__SCALIUS_ADMIN_ASSISTANT_PAGE_STATE__;
    expect(snapshot).toMatchObject({
      routePath: "/admin/customers/[redacted-email]",
      pageTitle: "Customers [redacted-email] [redacted-phone]",
      pageHeading: "Customer [redacted-email] [redacted-phone]",
      mainScroll: {
        top: 300,
        maxTop: 1_000,
        viewportHeight: 500,
        contentHeight: 1_500,
      },
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("SuperSecret123");
    expect(JSON.stringify(snapshot)).not.toContain("Raw note");
    expect(JSON.stringify(snapshot)).not.toContain("alice@example.com");
    expect(JSON.stringify(snapshot)).not.toContain("+8801712345678");
    expect(JSON.stringify(snapshot)).not.toContain("chk_leak");
  });

  it("publishes no page state when the super-admin surface is disabled", () => {
    act(() => {
      root.render(
        <AdminAssistantPageStateBridge
          enabled={false}
          routePath="/admin/products"
        />,
      );
    });

    expect(animationFrameCallbacks).toHaveLength(0);
    expect(window.__SCALIUS_ADMIN_ASSISTANT_PAGE_STATE__).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("updates the global snapshot after registered surface and scroll changes", () => {
    act(() => {
      root.render(<AdminAssistantPageStateBridge routePath="/admin/orders" />);
    });
    flushAnimationFrame();

    const handle = registerAdminAssistantSurface({
      id: "orders-table",
      kind: "table",
      label: "Orders",
      rowCount: 12,
      selectedCount: 2,
    });
    flushAnimationFrame();

    expect(window.__SCALIUS_ADMIN_ASSISTANT_PAGE_STATE__?.surfaces).toEqual([
      {
        id: "orders-table",
        kind: "table",
        label: "Orders",
        rowCount: 12,
        selectedCount: 2,
      },
    ]);

    scrollElement.scrollTop = 900;
    act(() => {
      scrollElement.dispatchEvent(new Event("scroll"));
    });
    flushAnimationFrame();

    expect(window.__SCALIUS_ADMIN_ASSISTANT_PAGE_STATE__?.mainScroll.top).toBe(900);

    handle.unregister();
    flushAnimationFrame();
    expect(window.__SCALIUS_ADMIN_ASSISTANT_PAGE_STATE__?.surfaces).toEqual([]);
  });
});
