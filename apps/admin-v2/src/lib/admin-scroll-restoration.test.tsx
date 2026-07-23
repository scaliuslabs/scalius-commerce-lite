// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAdminNestedScrollRestoration } from "./admin-scroll-restoration";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type RouterEventName = "onBeforeLoad" | "onRendered";
type RouterEvent = {
  fromLocation?: { href: string };
  toLocation: { href: string };
  pathChanged?: boolean;
  hrefChanged?: boolean;
};

const routerMock = vi.hoisted(() => {
  const subscribers = new Map<RouterEventName, Set<(event: RouterEvent) => void>>();

  return {
    subscribers,
    router: {
      subscribe: vi.fn(
        (eventName: RouterEventName, listener: (event: RouterEvent) => void) => {
          const listeners = subscribers.get(eventName) ?? new Set();
          listeners.add(listener);
          subscribers.set(eventName, listeners);

          return () => {
            listeners.delete(listener);
          };
        },
      ),
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => routerMock.router,
}));

function AdminScrollRestorationHarness() {
  useAdminNestedScrollRestoration();
  return null;
}

function emitRouterEvent(eventName: RouterEventName, event: RouterEvent) {
  for (const listener of routerMock.subscribers.get(eventName) ?? []) {
    listener(event);
  }
}

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

function createAdminScrollElement(metrics: { clientHeight: number; scrollHeight: number }) {
  const element = document.createElement("main");
  element.id = "admin-main-scroll";
  defineScrollMetrics(element, metrics);
  document.body.append(element);
  return element;
}

describe("useAdminNestedScrollRestoration", () => {
  let root: Root;
  let host: HTMLDivElement;
  let animationFrameCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    routerMock.subscribers.clear();
    routerMock.router.subscribe.mockClear();
    window.sessionStorage.clear();
    document.body.innerHTML = "";
    animationFrameCallbacks = [];

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
      animationFrameCallbacks[handle - 1] = () => undefined;
    });

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root.render(<AdminScrollRestorationHarness />);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    vi.restoreAllMocks();
  });

  function flushAnimationFrames(count = 1) {
    for (let index = 0; index < count; index += 1) {
      const callback = animationFrameCallbacks.shift();
      if (!callback) return;

      act(() => {
        callback(performance.now());
      });
    }
  }

  it("resets forward navigation to TanStack Router while restoring back navigation after delayed content height", () => {
    const scrollElement = createAdminScrollElement({
      clientHeight: 400,
      scrollHeight: 1_600,
    });
    scrollElement.scrollTop = 720;

    act(() => {
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/products" },
        toLocation: { href: "/admin/categories" },
      });
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/products" },
        toLocation: { href: "/admin/categories" },
      });
    });

    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    scrollElement.scrollTop = 0;

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/categories" },
        toLocation: { href: "/admin/products" },
      });
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/categories" },
        toLocation: { href: "/admin/products" },
      });
    });

    defineScrollMetrics(scrollElement, {
      clientHeight: 400,
      scrollHeight: 400,
    });
    flushAnimationFrames(10);
    expect(scrollElement.scrollTop).toBe(0);

    defineScrollMetrics(scrollElement, {
      clientHeight: 400,
      scrollHeight: 1_600,
    });
    flushAnimationFrames(1);

    expect(scrollElement.scrollTop).toBe(720);
  });

  it("opens a directly selected workspace tab at the top even when it was visited before", () => {
    const scrollElement = createAdminScrollElement({
      clientHeight: 400,
      scrollHeight: 1_600,
    });
    scrollElement.scrollTop = 720;

    act(() => {
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/settings?section=seo" },
        toLocation: { href: "/admin/settings?section=email" },
        pathChanged: false,
        hrefChanged: true,
      });
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/settings?section=seo" },
        toLocation: { href: "/admin/settings?section=email" },
        pathChanged: false,
        hrefChanged: true,
      });
    });

    flushAnimationFrames();
    expect(scrollElement.scrollTop).toBe(0);
    scrollElement.scrollTop = 0;

    act(() => {
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/settings?section=email" },
        toLocation: { href: "/admin/settings?section=seo" },
        pathChanged: false,
        hrefChanged: true,
      });
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/settings?section=email" },
        toLocation: { href: "/admin/settings?section=seo" },
        pathChanged: false,
        hrefChanged: true,
      });
    });
    flushAnimationFrames();

    expect(scrollElement.scrollTop).toBe(0);
  });

  it("restores each workspace tab when browser history traverses to it", () => {
    const scrollElement = createAdminScrollElement({
      clientHeight: 400,
      scrollHeight: 1_600,
    });
    scrollElement.scrollTop = 720;

    act(() => {
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/settings?section=seo" },
        toLocation: { href: "/admin/settings?section=email" },
        pathChanged: false,
        hrefChanged: true,
      });
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/settings?section=seo" },
        toLocation: { href: "/admin/settings?section=email" },
        pathChanged: false,
        hrefChanged: true,
      });
    });

    expect(scrollElement.scrollTop).toBe(0);

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/settings?section=email" },
        toLocation: { href: "/admin/settings?section=seo" },
        pathChanged: false,
        hrefChanged: true,
      });
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/settings?section=email" },
        toLocation: { href: "/admin/settings?section=seo" },
        pathChanged: false,
        hrefChanged: true,
      });
    });
    flushAnimationFrames();

    expect(scrollElement.scrollTop).toBe(720);
  });

  it("starts a first-time workspace tab at the top before its content swaps", () => {
    const scrollElement = createAdminScrollElement({
      clientHeight: 400,
      scrollHeight: 1_600,
    });
    scrollElement.scrollTop = 720;

    act(() => {
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/settings?section=seo" },
        toLocation: { href: "/admin/settings?section=email" },
        pathChanged: false,
        hrefChanged: true,
      });
    });

    expect(scrollElement.scrollTop).toBe(0);

    act(() => {
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/settings?section=seo" },
        toLocation: { href: "/admin/settings?section=email" },
        pathChanged: false,
        hrefChanged: true,
      });
    });
    flushAnimationFrames();

    expect(scrollElement.scrollTop).toBe(0);
  });

  it("does not reset scroll for filters within the active workspace tab", () => {
    const scrollElement = createAdminScrollElement({
      clientHeight: 400,
      scrollHeight: 1_600,
    });
    scrollElement.scrollTop = 720;

    act(() => {
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/media?folder=all&sort=newest" },
        toLocation: { href: "/admin/media?folder=all&sort=oldest" },
        pathChanged: false,
        hrefChanged: true,
      });
    });

    expect(scrollElement.scrollTop).toBe(720);
  });
});
