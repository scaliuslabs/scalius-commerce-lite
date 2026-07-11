// @vitest-environment happy-dom

import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { SCALIUS_COMPUTER_RICH_TEXT_FILL_EVENT } from "@scalius/shared/assistant-computer";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FormActionBar } from "../../FormStickyHeader";
import { ProductActionBar } from "../../product-form/ProductStickyHeader";

import {
  createAdminAssistantComputerRuntime,
  isAllowedAdminComputerRoute,
} from "./runtime";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("@tanstack/react-router", () => ({ Link: "a" }));

describe("Admin assistant computer runtime", () => {
  const mountedRoots: Root[] = [];

  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/admin/products?status=active");
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
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

  it.each([
    { isEdit: false, actionLabel: "Create Product" },
    { isEdit: true, actionLabel: "Save Product" },
  ])(
    "batches complex product fields and executes ordinary $actionLabel while destructive controls stay human-only",
    async ({ isEdit, actionLabel }) => {
      document.body.innerHTML = `
        <main>
          <h1>${isEdit ? "Edit product" : "Create product"}</h1>
          <label for="product-name">Product name</label>
          <input id="product-name" name="name" />
          <div data-scalius-computer-rich-text="sanitized-html">
            <div role="textbox" contenteditable="true" aria-label="Product description"></div>
          </div>
          <label for="product-status">Product status</label>
          <select id="product-status">
            <option value="draft">Draft</option>
            <option value="active">Active</option>
          </select>
          <button data-scalius-computer-human-only>Delete Product</button>
          <div id="product-action-test-root"></div>
        </main>`;

      const richTextBridge = document.querySelector<HTMLElement>(
        "[data-scalius-computer-rich-text]",
      )!;
      const acceptedRichText = vi.fn((event: Event) => event.preventDefault());
      richTextBridge.addEventListener(
        SCALIUS_COMPUTER_RICH_TEXT_FILL_EVENT,
        acceptedRichText,
      );
      const save = vi.fn();
      const deleteProduct = vi.fn();
      document
        .querySelector("button[data-scalius-computer-human-only]")!
        .addEventListener("click", deleteProduct);

      const root = createRoot(
        document.getElementById("product-action-test-root")!,
      );
      mountedRoots.push(root);
      await act(async () => {
        root.render(
          createElement(ProductActionBar, {
            isEdit,
            isSubmitting: false,
            onSave: save,
          }),
        );
      });

      const runtime = createAdminAssistantComputerRuntime({
        threadId: `admin-product-${isEdit ? "edit" : "create"}`,
        tabId: "admin-product-tab",
      });
      const observed = await runtime.execute({
        binding: runtime.binding,
        program: "observe",
      });
      expect(observed.output).toContain(`button "${actionLabel}"`);
      expect(observed.output).not.toContain(
        `button "${actionLabel}" [human-only]`,
      );
      expect(observed.output).toContain(
        'button "Delete Product" [human-only]',
      );

      const productName = "Stormproof Trail Shoe";
      const richDescription =
        "<h2>Built for monsoon trails</h2><p>Waterproof, grippy, and light.</p>";
      const result = await runtime.execute({
        binding: runtime.binding,
        program: [
          `fill ${handleFor(observed.output, "Product name")} ${JSON.stringify(productName)}`,
          `fill ${handleFor(observed.output, "Product description")} ${JSON.stringify(richDescription)}`,
          `select ${handleFor(observed.output, "Product status")} "Active"`,
          `click ${handleFor(observed.output, actionLabel)}`,
        ].join("; "),
      });

      expect(result).toMatchObject({ ok: true, code: "EXECUTED" });
      expect(
        document.querySelector<HTMLInputElement>('input[name="name"]')?.value,
      ).toBe(productName);
      expect(
        document.querySelector<HTMLSelectElement>("#product-status")?.value,
      ).toBe("active");
      expect(acceptedRichText).toHaveBeenCalledOnce();
      expect(
        (acceptedRichText.mock.calls[0]?.[0] as CustomEvent<unknown>).detail,
      ).toBe(richDescription);
      expect(save).toHaveBeenCalledOnce();

      const afterSave = await runtime.execute({
        binding: runtime.binding,
        program: "observe",
      });
      await expect(
        runtime.execute({
          binding: runtime.binding,
          program: `click ${handleFor(afterSave.output, "Delete Product")}`,
        }),
      ).resolves.toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
      expect(deleteProduct).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      title: "Categories",
      isEdit: false,
      actionLabel: "Create Category",
      richText: true,
    },
    {
      title: "Categories",
      isEdit: true,
      actionLabel: "Save Category",
      richText: true,
    },
    {
      title: "Collections",
      isEdit: false,
      actionLabel: "Create Collection",
      richText: false,
    },
    {
      title: "Collections",
      isEdit: true,
      actionLabel: "Save Collection",
      richText: false,
    },
  ])(
    "batches catalog-container fields and executes ordinary $actionLabel",
    async ({ title, isEdit, actionLabel, richText }) => {
      document.body.innerHTML = `
        <main>
          <label for="entity-name">${title === "Categories" ? "Category" : "Collection"} name</label>
          <input id="entity-name" />
          ${
            richText
              ? `<div data-scalius-computer-rich-text="sanitized-html">
                  <div role="textbox" contenteditable="true" aria-label="Category description"></div>
                </div>`
              : `<label for="buyer-subtitle">Buyer subtitle</label>
                <input id="buyer-subtitle" />`
          }
          <div id="form-action-test-root"></div>
        </main>`;

      const acceptedRichText = vi.fn((event: Event) => event.preventDefault());
      document
        .querySelector("[data-scalius-computer-rich-text]")
        ?.addEventListener(
          SCALIUS_COMPUTER_RICH_TEXT_FILL_EVENT,
          acceptedRichText,
        );
      const save = vi.fn();
      const root = createRoot(document.getElementById("form-action-test-root")!);
      mountedRoots.push(root);
      await act(async () => {
        root.render(
          createElement(FormActionBar, {
            title,
            isEdit,
            isSubmitting: false,
            cancelUrl: `/admin/${title.toLowerCase()}`,
            saveLabel: actionLabel,
            allowAssistantSave: true,
            onSave: save,
          }),
        );
      });

      const runtime = createAdminAssistantComputerRuntime({
        threadId: `admin-${title.toLowerCase()}-${isEdit ? "edit" : "create"}`,
        tabId: "admin-catalog-container-tab",
      });
      const observed = await runtime.execute({
        binding: runtime.binding,
        program: "observe",
      });
      expect(observed.output).toContain(`button "${actionLabel}"`);
      expect(observed.output).not.toContain(
        `button "${actionLabel}" [human-only]`,
      );

      const entityLabel =
        title === "Categories" ? "Category name" : "Collection name";
      const draftCommand = richText
        ? `fill ${handleFor(observed.output, "Category description")} ${JSON.stringify("<h2>Summer edit</h2><p>Buyer-ready catalog copy.</p>")}`
        : `fill ${handleFor(observed.output, "Buyer subtitle")} "A tightly curated buyer edit"`;
      const result = await runtime.execute({
        binding: runtime.binding,
        program: [
          `fill ${handleFor(observed.output, entityLabel)} "Summer Edit"`,
          draftCommand,
          `click ${handleFor(observed.output, actionLabel)}`,
        ].join("; "),
      });

      expect(result).toMatchObject({ ok: true, code: "EXECUTED" });
      expect(document.querySelector<HTMLInputElement>("#entity-name")?.value)
        .toBe("Summer Edit");
      if (richText) expect(acceptedRichText).toHaveBeenCalledOnce();
      else {
        expect(
          document.querySelector<HTMLInputElement>("#buyer-subtitle")?.value,
        ).toBe("A tightly curated buyer edit");
      }
      expect(save).toHaveBeenCalledOnce();
    },
  );

  it("keeps Order, financial, and destructive actions human-only by default", async () => {
    document.body.innerHTML = `
      <main>
        <button>Refund Payment</button>
        <button>Delete Category</button>
        <div id="default-form-action-test-root"></div>
      </main>`;
    const createOrder = vi.fn();
    const root = createRoot(
      document.getElementById("default-form-action-test-root")!,
    );
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        createElement(FormActionBar, {
          title: "Orders",
          isEdit: false,
          isSubmitting: false,
          cancelUrl: "/admin/orders",
          onSave: createOrder,
        }),
      );
    });

    const runtime = createAdminAssistantComputerRuntime({
      threadId: "admin-order-create-default",
      tabId: "admin-order-create-tab",
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    expect(observed.output).toContain('button "Create Order" [human-only]');
    expect(observed.output).toContain('button "Refund Payment" [human-only]');
    expect(observed.output).toContain('button "Delete Category" [human-only]');

    await expect(
      runtime.execute({
        binding: runtime.binding,
        program: `click ${handleFor(observed.output, "Create Order")}`,
      }),
    ).resolves.toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    expect(createOrder).not.toHaveBeenCalled();
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
      authorizedNavigationRoutes: ["/admin/orders?status=pending"],
    })).resolves.toMatchObject({ ok: true, code: "NAVIGATED" });
    expect(navigate).toHaveBeenCalledWith("/admin/orders?status=pending");
    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'goto "/products"',
      authorizedNavigationRoutes: ["/products"],
    })).resolves.toMatchObject({ ok: false, code: "ROUTE_BLOCKED" });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'goto "/admin/settings/taxes"',
      authorizedNavigationRoutes: ["/admin/settings/taxes"],
    })).resolves.toMatchObject({ ok: true, code: "NAVIGATED" });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'goto "/admin/products/prod_private"',
      authorizedNavigationRoutes: ["/admin/products/prod_private"],
    })).resolves.toMatchObject({ ok: false, code: "ROUTE_BLOCKED" });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: 'goto "/admin/not-a-catalog-route"',
      authorizedNavigationRoutes: ["/admin/not-a-catalog-route"],
    })).resolves.toMatchObject({ ok: false, code: "ROUTE_BLOCKED" });
    await expect(runtime.execute({
      binding: runtime.binding,
      program: "refresh",
    })).resolves.toMatchObject({ ok: true, code: "REFRESHED" });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    "/admin/products/new",
    "/admin/categories/new",
    "/admin/collections/new",
    "/admin/orders/new",
    "/admin/customers/new",
    "/admin/discounts/new",
  ])("keeps the browser route catalog aligned for create tasks: %s", async (route) => {
    const navigate = vi.fn();
    const runtime = createAdminAssistantComputerRuntime({
      threadId: "admin-thread-create",
      tabId: "admin-tab-create",
      navigate,
    });

    await expect(runtime.execute({
      binding: runtime.binding,
      program: `goto "${route}"`,
      authorizedNavigationRoutes: [route],
    })).resolves.toMatchObject({ ok: true, code: "NAVIGATED" });
    expect(navigate).toHaveBeenCalledWith(route);
  });

  it("fails closed for malformed encoded paths instead of throwing", () => {
    expect(isAllowedAdminComputerRoute("/admin/products/%E0%A4%A")).toBe(false);
  });

  it("applies the current merchant's page permissions at the browser boundary", () => {
    const productViewer = {
      isSuperAdmin: false,
      permissions: new Set([PERMISSIONS.PRODUCTS_VIEW]),
    };
    expect(
      isAllowedAdminComputerRoute("/admin/products", productViewer),
    ).toBe(true);
    expect(
      isAllowedAdminComputerRoute("/admin/products/new", productViewer),
    ).toBe(false);
    expect(
      isAllowedAdminComputerRoute("/admin/settings/taxes", productViewer),
    ).toBe(false);
    expect(
      isAllowedAdminComputerRoute("/admin/products/new", {
        isSuperAdmin: false,
        permissions: new Set([PERMISSIONS.PRODUCTS_CREATE]),
      }),
    ).toBe(true);
    expect(
      isAllowedAdminComputerRoute("/admin/settings/taxes", {
        isSuperAdmin: true,
        permissions: new Set(),
      }),
    ).toBe(true);
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

function handleFor(output: string, accessibleName: string): string {
  const line = output
    .split("\n")
    .find((candidate) => candidate.includes(`"${accessibleName}"`));
  const handle = line?.match(/(@r\d+\.e\d+)/)?.[1];
  if (!handle) {
    throw new Error(`Missing computer handle for ${accessibleName}: ${output}`);
  }
  return handle;
}
