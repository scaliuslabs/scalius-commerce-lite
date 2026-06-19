import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminRouteGuard } from "~/lib/auth.fns";
import {
  ADMIN_ROUTE_CONTEXT_FRESH_MS,
  ADMIN_ROUTE_CONTEXT_STALE_MS,
  clearAdminRouteContextCache,
  getAdminRouteContext,
  primeAdminRouteContextCache,
  refreshAdminRouteContext,
} from "./admin-route-context";

const mocks = vi.hoisted(() => ({
  adminRouteGuard: vi.fn(),
}));

vi.mock("~/lib/auth.fns", () => ({
  adminRouteGuard: mocks.adminRouteGuard,
}));

type AdminRouteContext = Awaited<ReturnType<typeof adminRouteGuard>>;

function makeContext(id: string): AdminRouteContext {
  return {
    user: {
      id,
      name: `User ${id}`,
      email: `${id}@example.com`,
      image: null,
      role: "admin",
      twoFactorEnabled: false,
      isSuperAdmin: true,
    },
    permissions: ["dashboard.view"],
    isSuperAdmin: true,
    hasAdminAccess: true,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("admin route context cache", () => {
  const guard = vi.mocked(adminRouteGuard);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal("window", {});
    guard.mockReset();
    clearAdminRouteContextCache();
  });

  afterEach(() => {
    clearAdminRouteContextCache();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("serves fresh client context without rerunning the server guard", async () => {
    const context = makeContext("fresh");

    primeAdminRouteContextCache(context);
    vi.advanceTimersByTime(ADMIN_ROUTE_CONTEXT_FRESH_MS - 1);

    await expect(getAdminRouteContext()).resolves.toBe(context);
    expect(guard).not.toHaveBeenCalled();
  });

  it("serves stale context immediately and refreshes it in one background flight", async () => {
    const staleContext = makeContext("stale");
    const refreshedContext = makeContext("refreshed");
    let resolveRefresh: (context: AdminRouteContext) => void = () => {};
    const refreshPromise = new Promise<AdminRouteContext>((resolve) => {
      resolveRefresh = resolve;
    });

    guard.mockReturnValue(refreshPromise);
    primeAdminRouteContextCache(staleContext);
    vi.advanceTimersByTime(ADMIN_ROUTE_CONTEXT_FRESH_MS + 1);

    const firstResult = await getAdminRouteContext();
    const secondResult = await getAdminRouteContext();

    expect(firstResult).toBe(staleContext);
    expect(secondResult).toBe(staleContext);
    expect(guard).toHaveBeenCalledTimes(1);

    resolveRefresh(refreshedContext);
    await refreshPromise;
    await flushMicrotasks();

    await expect(getAdminRouteContext()).resolves.toBe(refreshedContext);
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it("keeps a long-idle tab responsive by serving cached context while refreshing", async () => {
    const idleContext = makeContext("idle");
    const refreshedContext = makeContext("idle-refreshed");
    let resolveRefresh: (context: AdminRouteContext) => void = () => {};
    const refreshPromise = new Promise<AdminRouteContext>((resolve) => {
      resolveRefresh = resolve;
    });

    guard.mockReturnValue(refreshPromise);
    primeAdminRouteContextCache(idleContext);
    vi.advanceTimersByTime(30 * 60_000);

    await expect(getAdminRouteContext()).resolves.toBe(idleContext);
    expect(guard).toHaveBeenCalledTimes(1);

    resolveRefresh(refreshedContext);
    await refreshPromise;
    await flushMicrotasks();

    await expect(getAdminRouteContext()).resolves.toBe(refreshedContext);
  });

  it("blocks on the server guard once cached context hard-expires", async () => {
    const staleContext = makeContext("expired");
    const reloadedContext = makeContext("reloaded");

    guard.mockResolvedValue(reloadedContext);
    primeAdminRouteContextCache(staleContext);
    vi.advanceTimersByTime(ADMIN_ROUTE_CONTEXT_STALE_MS + 1);

    await expect(getAdminRouteContext()).resolves.toBe(reloadedContext);
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it("does not let an older background refresh repopulate a cleared cache", async () => {
    const staleContext = makeContext("stale");
    const refreshedContext = makeContext("refreshed");
    const reloadedContext = makeContext("reloaded");
    let resolveRefresh: (context: AdminRouteContext) => void = () => {};
    const refreshPromise = new Promise<AdminRouteContext>((resolve) => {
      resolveRefresh = resolve;
    });

    guard.mockReturnValueOnce(refreshPromise).mockResolvedValueOnce(reloadedContext);
    primeAdminRouteContextCache(staleContext);
    vi.advanceTimersByTime(ADMIN_ROUTE_CONTEXT_FRESH_MS + 1);

    await expect(getAdminRouteContext()).resolves.toBe(staleContext);
    clearAdminRouteContextCache();
    resolveRefresh(refreshedContext);
    await refreshPromise;
    await flushMicrotasks();

    await expect(getAdminRouteContext()).resolves.toBe(reloadedContext);
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("clears cached context before router invalidation refreshes route state", async () => {
    const context = makeContext("cached");
    const nextContext = makeContext("next");
    const router = { invalidate: vi.fn().mockResolvedValue(undefined) };

    guard.mockResolvedValue(nextContext);
    primeAdminRouteContextCache(context);

    await refreshAdminRouteContext(router);
    await expect(getAdminRouteContext()).resolves.toBe(nextContext);

    expect(router.invalidate).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledTimes(1);
  });
});
