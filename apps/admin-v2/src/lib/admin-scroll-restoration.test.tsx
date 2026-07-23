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
    currentHref: "/admin/products",
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
  useLocation: () => routerMock.currentHref,
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
  const content = document.createElement("div");
  content.dataset.adminScrollContent = "";
  element.append(content);
  defineScrollMetrics(element, metrics);
  document.body.append(element);
  return element;
}

function getScrollContent(scrollElement: HTMLElement) {
  return scrollElement.querySelector<HTMLElement>(
    "[data-admin-scroll-content]",
  )!;
}

describe("useAdminNestedScrollRestoration", () => {
  let root: Root;
  let host: HTMLDivElement;
  let animationFrameCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    routerMock.subscribers.clear();
    routerMock.router.subscribe.mockClear();
    routerMock.currentHref = "/admin/products";
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

  it("lets TanStack reset forward navigation and holds back navigation while delayed content returns", () => {
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
    });

    defineScrollMetrics(scrollElement, {
      clientHeight: 400,
      scrollHeight: 400,
    });

    act(() => {
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/categories" },
        toLocation: { href: "/admin/products" },
      });
    });

    expect(scrollElement.scrollTop).toBe(720);
    flushAnimationFrames(10);
    expect(scrollElement.scrollTop).toBe(720);

    defineScrollMetrics(scrollElement, {
      clientHeight: 400,
      scrollHeight: 1_600,
    });
    flushAnimationFrames(1);

    expect(scrollElement.scrollTop).toBe(720);
  });

  it("restores a directly selected workspace tab to its own position", () => {
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
    scrollElement.scrollTop = 160;

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
    expect(scrollElement.scrollTop).toBe(720);
  });

  it("restores a workspace in the destination layout commit before onRendered", () => {
    const scrollElement = createAdminScrollElement({
      clientHeight: 400,
      scrollHeight: 1_600,
    });
    scrollElement.scrollTop = 720;
    routerMock.currentHref = "/admin/settings?section=seo";

    act(() => {
      root.render(<AdminScrollRestorationHarness />);
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/settings?section=seo" },
        toLocation: { href: "/admin/settings?section=email" },
      });
    });

    scrollElement.scrollTop = 0;
    routerMock.currentHref = "/admin/settings?section=email";

    act(() => {
      root.render(<AdminScrollRestorationHarness />);
    });

    expect(scrollElement.scrollTop).toBe(0);
    scrollElement.scrollTop = 180;

    act(() => {
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/settings?section=email" },
        toLocation: { href: "/admin/settings?section=seo" },
      });
    });
    routerMock.currentHref = "/admin/settings?section=seo";

    act(() => {
      root.render(<AdminScrollRestorationHarness />);
    });

    expect(scrollElement.scrollTop).toBe(720);
    expect(getScrollContent(scrollElement).style.minHeight).toBe("");
  });

  it("restores the durable Products and SKUs tax sub-workspaces independently", () => {
    const scrollElement = createAdminScrollElement({
      clientHeight: 400,
      scrollHeight: 1_600,
    });
    scrollElement.scrollTop = 640;

    act(() => {
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/settings/taxes?section=classification" },
        toLocation: { href: "/admin/settings/taxes?section=classification&kind=variant" },
      });
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/settings/taxes?section=classification" },
        toLocation: { href: "/admin/settings/taxes?section=classification&kind=variant" },
      });
    });

    expect(scrollElement.scrollTop).toBe(0);
    scrollElement.scrollTop = 280;

    act(() => {
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/settings/taxes?section=classification&kind=variant" },
        toLocation: { href: "/admin/settings/taxes?section=classification" },
      });
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/settings/taxes?section=classification&kind=variant" },
        toLocation: { href: "/admin/settings/taxes?section=classification" },
      });
    });

    expect(scrollElement.scrollTop).toBe(640);
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
    expect(scrollElement.scrollTop).toBe(720);
  });

  it("keeps the outgoing workspace stable until a first-time tab has rendered", () => {
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

    expect(scrollElement.scrollTop).toBe(720);

    act(() => {
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/settings?section=seo" },
        toLocation: { href: "/admin/settings?section=email" },
        pathChanged: false,
        hrefChanged: true,
      });
    });
    expect(scrollElement.scrollTop).toBe(0);
  });

  it("holds the outgoing scroll range until a delayed workspace can restore", () => {
    const scrollElement = createAdminScrollElement({
      clientHeight: 400,
      scrollHeight: 1_600,
    });
    const contentElement = getScrollContent(scrollElement);
    scrollElement.scrollTop = 720;

    act(() => {
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/settings?section=seo" },
        toLocation: { href: "/admin/settings?section=email" },
      });
    });

    expect(scrollElement.scrollTop).toBe(720);
    expect(contentElement.style.minHeight).toBe("1600px");

    defineScrollMetrics(scrollElement, {
      clientHeight: 400,
      scrollHeight: 400,
    });

    act(() => {
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/settings?section=seo" },
        toLocation: { href: "/admin/settings?section=email" },
      });
    });

    expect(scrollElement.scrollTop).toBe(0);
    expect(contentElement.style.minHeight).toBe("");

    scrollElement.scrollTop = 280;
    act(() => {
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/settings?section=email" },
        toLocation: { href: "/admin/settings?section=seo" },
      });
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/settings?section=email" },
        toLocation: { href: "/admin/settings?section=seo" },
      });
    });

    expect(scrollElement.scrollTop).toBe(720);
    expect(contentElement.style.minHeight).toBe("1120px");

    defineScrollMetrics(scrollElement, {
      clientHeight: 400,
      scrollHeight: 1_600,
    });
    flushAnimationFrames();

    expect(scrollElement.scrollTop).toBe(720);
    expect(contentElement.style.minHeight).toBe("");
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

  it("does not treat tax search and pagination as workspace changes", () => {
    const scrollElement = createAdminScrollElement({
      clientHeight: 400,
      scrollHeight: 1_600,
    });
    scrollElement.scrollTop = 520;

    act(() => {
      emitRouterEvent("onBeforeLoad", {
        fromLocation: { href: "/admin/settings/taxes?section=classification&kind=variant" },
        toLocation: { href: "/admin/settings/taxes?section=classification&kind=variant&query=shoe&page=2" },
      });
      emitRouterEvent("onRendered", {
        fromLocation: { href: "/admin/settings/taxes?section=classification&kind=variant" },
        toLocation: { href: "/admin/settings/taxes?section=classification&kind=variant&query=shoe&page=2" },
      });
    });

    expect(scrollElement.scrollTop).toBe(520);
  });
});
