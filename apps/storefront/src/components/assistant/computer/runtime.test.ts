// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createStorefrontAssistantComputerRuntime } from "./runtime";
import { buildStorefrontComputerAddToCartLabel } from "../../product/lib/computer-add-to-cart";

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
    const linkHandle = observed.output.match(
      /(@r\d+\.e\d+) link "Browse shoes"/u,
    )?.[1];
    expect(linkHandle).toBeTruthy();
    const link = document.querySelector<HTMLAnchorElement>("a")!;
    const clicked = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener("click", clicked);
    await expect(runtime.execute({
      binding: runtime.binding,
      program: `click ${linkHandle}`,
    })).resolves.toMatchObject({ ok: false, code: "ROUTE_BLOCKED" });
    expect(clicked).not.toHaveBeenCalled();
    await expect(runtime.execute({
      binding: runtime.binding,
      program: `click ${linkHandle}`,
      authorizedNavigationRoutes: ["/collections/shoes"],
    })).resolves.toMatchObject({ ok: true, code: "EXECUTED" });
    expect(clicked).toHaveBeenCalledOnce();

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
    "/checkout",
    "/checkout/payment",
    "/buy",
    "/buy/red-shoe",
    "/account",
    "/account/orders/order_1",
    "/order-success",
    "/payment-recovery",
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
      authorizedNavigationRoutes: [route],
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
      authorizedNavigationRoutes: ["/search?q=running%20shoe"],
    })).resolves.toMatchObject({ ok: true, code: "NAVIGATED" });
    expect(navigate).toHaveBeenCalledWith("/search?q=running%20shoe");
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

  it.each([
    "/cart",
    "/buy/red-shoe",
    "/checkout",
    "/account",
    "/account/orders/order_1",
    "/order-success",
    "/payment-recovery",
  ])("does not observe or control private buyer page %s", async (route) => {
    window.history.replaceState({}, "", route);
    document.body.innerHTML = `
      <main>
        <h1>Private order</h1>
        <p>Buyer phone 01700000000 receipt chk_private</p>
        <input aria-label="One-time code" value="123456" />
      </main>`;
    const navigate = vi.fn();
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: "shop-private-thread",
      tabId: "shop-private-tab",
      navigate,
    });
    const observed = await runtime.execute({ binding: runtime.binding, program: "observe" });
    expect(observed).toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    expect(observed.output).not.toContain("01700000000");
    expect(observed.output).not.toContain("chk_private");
    expect(observed.output).not.toContain("123456");
    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'fill @r1.e1 "123456"',
    })).resolves.toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'goto "/products"',
      authorizedNavigationRoutes: ["/products"],
    })).resolves.toMatchObject({ ok: true, code: "NAVIGATED" });
    expect(navigate).toHaveBeenCalledWith("/products");
    await expect(runtime.execute({
      binding: { ...runtime.binding, threadId: "wrong-thread" },
      program: "observe",
    })).resolves.toMatchObject({ ok: false, code: "INVALID_BINDING" });
  });

  it.each([
    "Add to cart",
    "Buy now",
    "Quick buy",
    "Open shopping cart",
    "Checkout",
    "Place order",
    "Pay now",
  ])("rejects unannotated commerce control %s in the real adapter", async (name) => {
    document.body.innerHTML = `<main><button aria-label="${name}">${name}</button></main>`;
    const button = document.querySelector<HTMLButtonElement>("button")!;
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: "shop-commerce-thread",
      tabId: "shop-commerce-tab",
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const handle = observed.output.match(/(@r\d+\.e\d+) button/u)?.[1];
    expect(handle).toBeTruthy();

    await expect(
      runtime.execute({
        binding: runtime.binding,
        program: `click ${handle}`,
      }),
    ).resolves.toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    expect(clicked).not.toHaveBeenCalled();
  });

  it("permits only the explicitly allowed, enabled Add to Cart control", async () => {
    document.body.innerHTML = `
      <main>
        <input type="button" value="Add Shoes, variant var_red to cart" />
        <div role="button" aria-label="Add Hat, variant var_blue to cart"></div>
        <button data-scalius-computer-action="allow" aria-label="Add Shoes, variant var_red, Size 40 to cart">Add to Cart</button>
        <button data-scalius-computer-action="allow">Buy Now</button>
        <button data-scalius-computer-action="allow" aria-label="Add Hat, variant var_green to cart" disabled>Add to Cart</button>
      </main>`;
    const unannotatedInput = document.querySelector<HTMLInputElement>("input")!;
    const unannotatedRole = document.querySelector<HTMLElement>('[role="button"]')!;
    const [add, buy, disabledAdd] = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    );
    const addClicked = vi.fn();
    const unannotatedInputClicked = vi.fn();
    const unannotatedRoleClicked = vi.fn();
    const buyClicked = vi.fn();
    const disabledClicked = vi.fn();
    unannotatedInput.addEventListener("click", unannotatedInputClicked);
    unannotatedRole.addEventListener("click", unannotatedRoleClicked);
    add?.addEventListener("click", addClicked);
    buy?.addEventListener("click", buyClicked);
    disabledAdd?.addEventListener("click", disabledClicked);
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: "shop-add-thread",
      tabId: "shop-add-tab",
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const inputHandle = observed.output.match(
      /(@r\d+\.e\d+) button "Add Shoes, variant var_red to cart"/u,
    )?.[1];
    const roleHandle = observed.output.match(
      /(@r\d+\.e\d+) button "Add Hat, variant var_blue to cart"/u,
    )?.[1];
    const addHandle = observed.output.match(
      /(@r\d+\.e\d+) button "Add Shoes, variant var_red, Size 40 to cart"/u,
    )?.[1];
    const buyHandle = observed.output.match(
      /(@r\d+\.e\d+) button "Buy Now"/u,
    )?.[1];
    expect(addHandle).toBeTruthy();
    expect(inputHandle).toBeTruthy();
    expect(roleHandle).toBeTruthy();
    expect(buyHandle).toBeTruthy();

    await expect(
      runtime.execute({
        binding: runtime.binding,
        program: `click ${addHandle}`,
      }),
    ).resolves.toMatchObject({ ok: true, code: "EXECUTED" });
    const refreshed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const refreshedBuyHandle = refreshed.output.match(
      /(@r\d+\.e\d+) button "Buy Now"/u,
    )?.[1];
    const refreshedInputHandle = refreshed.output.match(
      /(@r\d+\.e\d+) button "Add Shoes, variant var_red to cart"/u,
    )?.[1];
    await expect(
      runtime.execute({
        binding: runtime.binding,
        program: `click ${refreshedInputHandle}`,
      }),
    ).resolves.toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    const refreshedAfterBlock = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const buyAfterBlock = refreshedAfterBlock.output.match(
      /(@r\d+\.e\d+) button "Buy Now"/u,
    )?.[1];
    const roleAfterBlock = refreshedAfterBlock.output.match(
      /(@r\d+\.e\d+) button "Add Hat, variant var_blue to cart"/u,
    )?.[1];
    await expect(
      runtime.execute({
        binding: runtime.binding,
        program: `click ${roleAfterBlock}`,
      }),
    ).resolves.toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    const refreshedAfterRole = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const buyAfterRole = refreshedAfterRole.output.match(
      /(@r\d+\.e\d+) button "Buy Now"/u,
    )?.[1];
    await expect(
      runtime.execute({
        binding: runtime.binding,
        program: `click ${buyAfterRole}`,
      }),
    ).resolves.toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    expect(addClicked).toHaveBeenCalledOnce();
    expect(refreshedBuyHandle).toBeTruthy();
    expect(buyAfterBlock).toBeTruthy();
    expect(unannotatedInputClicked).not.toHaveBeenCalled();
    expect(unannotatedRoleClicked).not.toHaveBeenCalled();
    expect(buyHandle).toBeTruthy();
    expect(buyClicked).not.toHaveBeenCalled();
    expect(disabledClicked).not.toHaveBeenCalled();
  });

  it("allows a bounded maximum-length product identity without losing the action suffix", async () => {
    const variantId = `var_${"v".repeat(21)}`;
    const label = buildStorefrontComputerAddToCartLabel({
      productName: `Premium ${"P".repeat(92)}`,
      variantId,
      options: [{ name: "Size", label: "L".repeat(180) }],
    });
    document.body.innerHTML = `<main><button data-scalius-computer-action="allow" aria-label="${label}">Add to Cart</button></main>`;
    const clicked = vi.fn();
    document.querySelector("button")?.addEventListener("click", clicked);
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: "shop-long-add-thread",
      tabId: "shop-long-add-tab",
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const handle = observed.output.match(/(@r\d+\.e\d+) button/u)?.[1];
    expect(label.length).toBeLessThanOrEqual(160);
    expect(label).toContain(`variant ${variantId}`);
    expect(label).toMatch(/ to cart$/u);
    await expect(
      runtime.execute({
        binding: runtime.binding,
        program: `click ${handle}`,
      }),
    ).resolves.toMatchObject({ ok: true, code: "EXECUTED" });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("honors a commerce-surface human-only annotation for otherwise generic controls", async () => {
    document.body.innerHTML = `
      <main data-scalius-computer-human-only>
        <button aria-label="Decrease quantity">−</button>
      </main>`;
    const button = document.querySelector<HTMLButtonElement>("button")!;
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: "shop-annotated-cart-thread",
      tabId: "shop-annotated-cart-tab",
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const handle = observed.output.match(/(@r\d+\.e\d+) button/u)?.[1];
    expect(handle).toBeTruthy();
    await expect(
      runtime.execute({
        binding: runtime.binding,
        program: `click ${handle}`,
      }),
    ).resolves.toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    expect(clicked).not.toHaveBeenCalled();
  });

  it("stops the remaining actions in an in-flight batch after cancellation", async () => {
    document.body.innerHTML = `
      <main>
        <button role="combobox" aria-label="Color"></button>
        <select aria-label="Size">
          <option value="small">Small</option>
          <option value="large">Large</option>
        </select>
      </main>`;
    const color = document.querySelector<HTMLButtonElement>("button")!;
    color.addEventListener("click", () => {
      const option = document.createElement("button");
      option.setAttribute("role", "option");
      option.textContent = "Red";
      document.body.append(option);
    });
    const size = document.querySelector<HTMLSelectElement>("select")!;
    const sizeChanged = vi.fn();
    size.addEventListener("change", sizeChanged);
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: "shop-cancel-batch-thread",
      tabId: "shop-cancel-batch-tab",
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const colorHandle = observed.output.match(
      /(@r\d+\.e\d+) combobox "Color"/u,
    )?.[1];
    const sizeHandle = observed.output.match(
      /(@r\d+\.e\d+) combobox "Size"/u,
    )?.[1];
    expect(colorHandle).toBeTruthy();
    expect(sizeHandle).toBeTruthy();

    const execution = runtime.execute({
      binding: runtime.binding,
      program: `select ${colorHandle} "Red"; select ${sizeHandle} "large"`,
    });
    runtime.cancelPending();

    await expect(execution).resolves.toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      retryable: false,
    });
    expect(size.value).toBe("small");
    expect(sizeChanged).not.toHaveBeenCalled();
  });

  it.each([
    "token",
    "proof",
    "receipt",
    "otp",
    "code",
    "password",
    "secret",
    "recoveryToken",
  ])("rejects sensitive query key %s without inspecting its value", async (key) => {
    const navigate = vi.fn();
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: "shop-query-thread",
      tabId: "shop-query-tab",
      navigate,
    });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: `goto "/products/red-shoe?${key}=opaque"`,
      authorizedNavigationRoutes: [`/products/red-shoe?${key}=opaque`],
    })).resolves.toMatchObject({ ok: false, code: "ROUTE_BLOCKED" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not mistake ordinary query values for sensitive query keys", async () => {
    const navigate = vi.fn();
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: "shop-safe-query-thread",
      tabId: "shop-safe-query-tab",
      navigate,
    });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'goto "/search?q=secret%20code"',
      authorizedNavigationRoutes: ["/search?q=secret%20code"],
    })).resolves.toMatchObject({ ok: true, code: "NAVIGATED" });
    expect(navigate).toHaveBeenCalledWith("/search?q=secret%20code");
  });
});
