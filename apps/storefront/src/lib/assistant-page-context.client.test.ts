// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { cartStore, type CartStore } from "@/store/cart";
import {
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL,
  buildStorefrontAssistantPageContext,
  type StorefrontAssistantPageContextSnapshot,
} from "./assistant-page-context";
import {
  installStorefrontAssistantPageContextBridge,
  publishStorefrontAssistantPageContext,
} from "./assistant-page-context.client";

const cartMocks = vi.hoisted(() => ({
  hydrateCartFromStorage: vi.fn(),
}));

vi.mock("@/store/cart", async () => {
  const actual = await vi.importActual<typeof import("@/store/cart")>(
    "@/store/cart",
  );

  return {
    ...actual,
    hydrateCartFromStorage: cartMocks.hydrateCartFromStorage,
  };
});

const emptyCart: CartStore = {
  items: {},
  totalItems: 0,
  totalAmount: 0,
  discount: null,
};

describe("publishStorefrontAssistantPageContext", () => {
  beforeEach(() => {
    cartMocks.hydrateCartFromStorage.mockClear();
    cartStore.set(emptyCart);
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    document.title = "";
    window.history.replaceState(null, "", "/");
    delete window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL];
  });

  it("updates the browser global and dispatches the public context event", () => {
    const events: StorefrontAssistantPageContextSnapshot[] = [];
    window.addEventListener(
      STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
      (event) => {
        events.push(event.detail);
      },
    );

    const snapshot = buildStorefrontAssistantPageContext({
      path: "/products/widget?orderId=order_private_123",
      canonicalUrl: "https://shop.example.test/products/widget?token=secret",
      title: "Widget",
    });
    const published = publishStorefrontAssistantPageContext(snapshot);

    expect(published).toBe(snapshot);
    expect(
      (
        window as Window &
          Record<
            typeof STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL,
            StorefrontAssistantPageContextSnapshot | undefined
          >
      )[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL],
    ).toBe(snapshot);
    expect(events).toEqual([snapshot]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.cart)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("order_private_123");
    expect(JSON.stringify(snapshot)).not.toContain("token=secret");
  });

  it("installs passively from current cartStore state without hydrating storage", () => {
    const cartState: CartStore = {
      items: {
        "prod_current-var_current": {
          id: "prod_current",
          slug: "current-widget",
          name: "Current Widget",
          price: 125.5,
          quantity: 2,
          variantId: "var_current",
          size: "M",
        },
      },
      totalItems: 2,
      totalAmount: 251,
      discount: null,
    };
    cartStore.set(cartState);
    document.head.innerHTML =
      '<link rel="canonical" href="https://shop.example.test/products/current-widget?token=private">';
    document.title = "Current Widget";
    window.history.replaceState(null, "", "/products/current-widget");

    const events: StorefrontAssistantPageContextSnapshot[] = [];
    const onContextChange = (
      event: CustomEvent<StorefrontAssistantPageContextSnapshot>,
    ) => {
      events.push(event.detail);
    };
    window.addEventListener(
      STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
      onContextChange,
    );

    const published = installStorefrontAssistantPageContextBridge();

    window.removeEventListener(
      STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
      onContextChange,
    );
    expect(cartMocks.hydrateCartFromStorage).not.toHaveBeenCalled();
    expect(published?.cart).toMatchObject({
      totalItems: 2,
      subtotalAmount: 251,
      lineCount: 1,
      hasDiscount: false,
      truncated: false,
      lines: [
        {
          productId: "prod_current",
          variantId: "var_current",
          slug: "current-widget",
          name: "Current Widget",
          quantity: 2,
          unitPrice: 125.5,
          lineTotal: 251,
          options: [{ name: "Option 1", label: "M" }],
        },
      ],
    });
    expect(
      window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL],
    ).toBe(published);
    expect(events).toEqual([published]);
  });
});
