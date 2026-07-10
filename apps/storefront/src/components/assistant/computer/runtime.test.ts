// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createStorefrontAssistantComputerRuntime } from "./runtime";

describe("Storefront assistant computer runtime", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/products/red-shoe?size=large");
  });

  it("pins the Storefront thread/tab binding and exposes bounded buyer-page context", async () => {
    document.body.innerHTML = `
      <main>
        <h1>Red shoe</h1>
        <p>Lightweight everyday trainer.</p>
        <a href="/collections/shoes">Browse shoes</a>
      </main>`;
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: "shop-thread-1",
      tabId: "shop-tab-1",
    });

    expect(runtime.binding).toEqual({
      surface: "storefront",
      threadId: "shop-thread-1",
      tabId: "shop-tab-1",
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    expect(observed.output).toContain('route="/products/red-shoe?size=large"');
    expect(observed.output).toContain('heading "Red shoe"');
    expect(observed.output).toContain('text "Lightweight everyday trainer."');
    expect(observed.output).toContain('link "Browse shoes" route="/collections/shoes"');

    await expect(runtime.execute({
      binding: { ...runtime.binding, threadId: "another-thread" },
      program: "observe",
    })).resolves.toMatchObject({ ok: false, code: "INVALID_BINDING" });
    await expect(runtime.execute({
      binding: { ...runtime.binding, surface: "admin" },
      program: "observe",
    })).resolves.toMatchObject({ ok: false, code: "INVALID_BINDING" });
  });

  it.each([
    "/admin",
    "/admin/products",
    "/%61dmin/products",
    "/api/checkout",
    "/%61pi/checkout",
    "/_astro/app.js",
    "/.well-known/ucp",
    "/cdn-cgi/trace",
  ])("blocks non-buyer route %s", async (route) => {
    const navigate = vi.fn();
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: "shop-thread-2",
      tabId: "shop-tab-2",
      navigate,
    });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: `goto "${route}"`,
    })).resolves.toMatchObject({ ok: false, code: "ROUTE_BLOCKED" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("uses the injected router for same-origin buyer pages and refresh", async () => {
    const navigate = vi.fn();
    const refresh = vi.fn();
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: "shop-thread-3",
      tabId: "shop-tab-3",
      navigate,
      refresh,
    });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'goto "/search?q=running%20shoe"',
    })).resolves.toMatchObject({ ok: true, code: "NAVIGATED" });
    expect(navigate).toHaveBeenCalledWith("/search?q=running%20shoe");
    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'goto "/checkout"',
    })).resolves.toMatchObject({ ok: true, code: "NAVIGATED" });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: "refresh",
    })).resolves.toMatchObject({ ok: true, code: "REFRESHED" });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("fails closed when the bound tab is not active", async () => {
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: "shop-thread-4",
      tabId: "shop-tab-4",
      isActive: () => false,
    });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: "observe",
    })).resolves.toMatchObject({ ok: false, code: "INACTIVE_TAB" });
  });
});
