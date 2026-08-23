import { describe, expect, it, vi } from "vitest";
import type { AnyRoute, AnyRouter } from "@tanstack/react-router";
import {
  collectPermissionVisibleRouteHrefs,
  preloadAdminRouteChunks,
  scheduleAdminRouteChunkWarmup,
  type RouteWarmupWindow,
} from "./admin-route-chunk-warming";
import type { NavSection } from "./AdminNav";

function createWarmupWindow(connection: {
  effectiveType?: string;
  saveData?: boolean;
} = {}) {
  const idleCallbacks = new Map<
    number,
    (deadline: { didTimeout: boolean; timeRemaining(): number }) => void
  >();
  const eventListeners = new Map<string, Set<() => void>>();
  let nextHandle = 1;

  const addListener = (type: string, listener: () => void) => {
    const listeners = eventListeners.get(type) ?? new Set();
    listeners.add(listener);
    eventListeners.set(type, listeners);
  };
  const removeListener = (type: string, listener: () => void) => {
    eventListeners.get(type)?.delete(listener);
  };
  const connectionWithEvents = {
    ...connection,
    addEventListener: (_type: "change", listener: () => void) =>
      addListener("connection", listener),
    removeEventListener: (_type: "change", listener: () => void) =>
      removeListener("connection", listener),
  };

  const window = {
    requestIdleCallback: (callback) => {
      const handle = nextHandle++;
      idleCallbacks.set(handle, callback);
      return handle;
    },
    cancelIdleCallback: (handle) => {
      idleCallbacks.delete(handle);
    },
    setTimeout: () => nextHandle++,
    clearTimeout: () => undefined,
    navigator: { onLine: true, connection: connectionWithEvents },
    document: {
      hidden: false,
      addEventListener: addListener,
      removeEventListener: removeListener,
    },
    addEventListener: addListener,
    removeEventListener: removeListener,
  } satisfies RouteWarmupWindow;

  return {
    window,
    connection: connectionWithEvents,
    runNextIdle() {
      const entry = idleCallbacks.entries().next().value;
      if (!entry) return false;
      const [handle, callback] = entry;
      idleCallbacks.delete(handle);
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return true;
    },
    emit(type: string) {
      for (const listener of eventListeners.get(type) ?? []) listener();
    },
    get pendingIdleCount() {
      return idleCallbacks.size;
    },
  };
}

function createRouteRouter(paths: string[]) {
  const routesByPath: Record<string, AnyRoute> = {};
  const beforeLoad = vi.fn();
  const loader = vi.fn();
  const activeLoads = new Set<string>();
  let maxActiveLoads = 0;
  const resolvers: Array<() => void> = [];

  for (const path of paths) {
    routesByPath[`${path}/`] = {
      id: path,
      beforeLoad,
      options: { loader },
    } as unknown as AnyRoute;
  }

  const loadRouteChunk = vi.fn((route: AnyRoute) => {
    const id = String(route.id);
    activeLoads.add(id);
    maxActiveLoads = Math.max(maxActiveLoads, activeLoads.size);
    return new Promise<void>((resolve) => {
      resolvers.push(() => {
        activeLoads.delete(id);
        resolve();
      });
    });
  });

  return {
    router: { routesByPath, loadRouteChunk } as unknown as Pick<
      AnyRouter,
      "routesByPath" | "loadRouteChunk"
    >,
    beforeLoad,
    loader,
    loadRouteChunk,
    resolveNext() {
      resolvers.shift()?.();
    },
    get maxActiveLoads() {
      return maxActiveLoads;
    },
  };
}

describe("admin route chunk warming", () => {
  it("loads route code without invoking beforeLoad, loaders, or data APIs", async () => {
    const route = createRouteRouter(["/admin/products"]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const promise = preloadAdminRouteChunks(route.router, "/admin/products");
    expect(route.loadRouteChunk).toHaveBeenCalledOnce();
    route.resolveNext();
    await promise;

    expect(route.beforeLoad).not.toHaveBeenCalled();
    expect(route.loader).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("warms only permission-visible destinations with capped concurrency", async () => {
    const route = createRouteRouter([
      "/admin/products",
      "/admin/orders",
      "/admin/media",
    ]);
    const host = createWarmupWindow({ effectiveType: "4g" });
    const stop = scheduleAdminRouteChunkWarmup({
      router: route.router,
      hrefs: [
        "/admin/products",
        "/admin/orders",
        "/admin/media",
        "/admin/products",
      ],
      currentPath: "/admin",
      window: host.window,
    });

    expect(host.runNextIdle()).toBe(true);
    expect(route.loadRouteChunk).toHaveBeenCalledTimes(2);
    expect(route.maxActiveLoads).toBe(2);

    route.resolveNext();
    route.resolveNext();
    await vi.waitFor(() => expect(host.pendingIdleCount).toBe(1));
    expect(host.runNextIdle()).toBe(true);
    expect(route.loadRouteChunk).toHaveBeenCalledTimes(3);

    route.resolveNext();
    await Promise.resolve();
    stop();
  });

  it("pauses on data-saver connections and resumes when the connection improves", () => {
    const route = createRouteRouter(["/admin/products"]);
    const host = createWarmupWindow({ saveData: true, effectiveType: "4g" });
    const stop = scheduleAdminRouteChunkWarmup({
      router: route.router,
      hrefs: ["/admin/products"],
      currentPath: "/admin",
      window: host.window,
    });

    expect(host.pendingIdleCount).toBe(0);
    host.connection.saveData = false;
    host.emit("connection");
    expect(host.pendingIdleCount).toBe(1);

    stop();
    expect(host.pendingIdleCount).toBe(0);
  });

  it("cancels pending idle work when the persistent shell unmounts", () => {
    const route = createRouteRouter(["/admin/products"]);
    const host = createWarmupWindow({ effectiveType: "4g" });
    const controller = new AbortController();
    scheduleAdminRouteChunkWarmup({
      router: route.router,
      hrefs: ["/admin/products"],
      currentPath: "/admin",
      signal: controller.signal,
      window: host.window,
    });

    expect(host.pendingIdleCount).toBe(1);
    controller.abort();
    expect(host.pendingIdleCount).toBe(0);
    expect(host.runNextIdle()).toBe(false);
    expect(route.loadRouteChunk).not.toHaveBeenCalled();
  });

  it("deduplicates and prioritizes only destinations present after permission filtering", () => {
    const sections = [
      {
        label: "",
        items: [
          { name: "Media", href: "/admin/media", icon: () => null },
          {
            name: "Catalog",
            href: "/admin/products",
            icon: () => null,
            subItems: [
              { name: "Products", href: "/admin/products" },
              { name: "Categories", href: "/admin/categories" },
            ],
          },
        ],
      },
    ] satisfies NavSection[];

    expect(collectPermissionVisibleRouteHrefs(sections)).toEqual([
      "/admin/products",
      "/admin/categories",
      "/admin/media",
    ]);
  });
});
