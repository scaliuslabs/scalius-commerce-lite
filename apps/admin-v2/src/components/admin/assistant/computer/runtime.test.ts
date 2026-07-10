// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminAssistantComputerRuntime } from "./runtime";

describe("Admin assistant computer runtime", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/admin/products?status=active");
  });

  it("pins the Admin thread/tab binding and delegates visible DOM actions", async () => {
    document.body.innerHTML = `
      <main>
        <h1>Products</h1>
        <button data-scalius-computer-action="allow">Open filters</button>
      </main>
      <aside data-scalius-computer-exclude>
        <button>Minimize admin assistant</button>
        <textarea aria-label="Message admin assistant"></textarea>
      </aside>`;
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    const runtime = createAdminAssistantComputerRuntime({
      threadId: "admin-thread-1",
      tabId: "admin-tab-1",
    });

    expect(runtime.binding).toEqual({
      surface: "admin",
      threadId: "admin-thread-1",
      tabId: "admin-tab-1",
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    expect(observed.output).toContain('route="/admin/products?status=active"');
    expect(observed.output).toContain('heading "Products"');
    expect(observed.output).not.toContain("Minimize admin assistant");
    expect(observed.output).not.toContain("Message admin assistant");
    const handle = observed.output.match(/(@r\d+\.e\d+) button "Open filters"/)?.[1];
    expect(handle).toBeTruthy();
    await expect(runtime.execute({
      binding: runtime.binding,
      program: `click ${handle}`,
    })).resolves.toMatchObject({ ok: true, code: "EXECUTED" });
    expect(clicked).toHaveBeenCalledOnce();

    await expect(runtime.execute({
      binding: { ...runtime.binding, tabId: "another-tab" },
      program: "observe",
    })).resolves.toMatchObject({ ok: false, code: "INVALID_BINDING" });
    await expect(runtime.execute({
      binding: { ...runtime.binding, surface: "storefront" },
      program: "observe",
    })).resolves.toMatchObject({ ok: false, code: "INVALID_BINDING" });
  });

  it("routes only inside the Admin tree through the injected router", async () => {
    const navigate = vi.fn();
    const refresh = vi.fn();
    const runtime = createAdminAssistantComputerRuntime({
      threadId: "admin-thread-2",
      tabId: "admin-tab-2",
      navigate,
      refresh,
    });

    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'goto "/admin/orders?status=pending"',
    })).resolves.toMatchObject({ ok: true, code: "NAVIGATED" });
    expect(navigate).toHaveBeenCalledWith("/admin/orders?status=pending");
    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'goto "/products"',
    })).resolves.toMatchObject({ ok: false, code: "ROUTE_BLOCKED" });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'goto "/admin/settings/taxes"',
    })).resolves.toMatchObject({ ok: true, code: "NAVIGATED" });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'goto "/admin/products/prod_private"',
    })).resolves.toMatchObject({ ok: false, code: "ROUTE_BLOCKED" });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'goto "/admin/not-a-catalog-route"',
    })).resolves.toMatchObject({ ok: false, code: "ROUTE_BLOCKED" });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: "refresh",
    })).resolves.toMatchObject({ ok: true, code: "REFRESHED" });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("fails closed when the bound tab is not active", async () => {
    const runtime = createAdminAssistantComputerRuntime({
      threadId: "admin-thread-3",
      tabId: "admin-tab-3",
      isActive: () => false,
    });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: "observe",
    })).resolves.toMatchObject({ ok: false, code: "INACTIVE_TAB" });
  });
});
