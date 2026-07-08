// @vitest-environment happy-dom

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import { cartStore, type CartStore } from "@/store/cart";
import {
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL,
  buildStorefrontAssistantPageContext,
  type StorefrontAssistantPageContextSnapshot,
} from "./assistant-page-context";
import {
  STOREFRONT_ASSISTANT_BRIDGE_GLOBAL,
  installStorefrontAssistantPageContextBridge,
  publishStorefrontAssistantPageContext,
  resolveStorefrontAssistantNavigationTarget,
} from "./assistant-page-context.client";

const cartMocks = vi.hoisted(() => ({
  hydrateCartFromStorage: vi.fn(),
}));

vi.mock("@/store/cart", async () => {
  const actual =
    await vi.importActual<typeof import("@/store/cart")>("@/store/cart");

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

const originalLocationAssign = window.location.assign;
let locationAssignMock: Mock<(url: string | URL) => void>;

describe("publishStorefrontAssistantPageContext", () => {
  beforeEach(() => {
    locationAssignMock = vi.fn<(url: string | URL) => void>();
    window.location.assign = locationAssignMock;
    cartMocks.hydrateCartFromStorage.mockClear();
    cartStore.set(emptyCart);
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    document.title = "";
    window.history.replaceState(null, "", "/");
    delete window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL];
    delete window[STOREFRONT_ASSISTANT_BRIDGE_GLOBAL];
  });

  afterEach(() => {
    window.location.assign = originalLocationAssign;
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
    expect(window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL]).toBe(published);
    expect(events).toEqual([published]);
  });

  it("exposes a frozen public assistant bridge with a sanitized context getter", () => {
    document.title = "Widget buyer@example.test";
    window.history.replaceState(null, "", "/products/widget");

    const published = installStorefrontAssistantPageContextBridge();
    const bridge = window[STOREFRONT_ASSISTANT_BRIDGE_GLOBAL];

    expect(bridge).toBeDefined();
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(bridge?.getContext()).toBe(published);

    delete window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL];

    const republished = bridge?.getContext();
    expect(republished?.page.path).toBe("/products/widget");
    expect(republished?.page.kind).toBe("product");
    expect(republished?.page.title).toBe("Widget [redacted-email]");
    expect(Object.isFrozen(republished)).toBe(true);
    expect(window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL]).toBe(republished);
  });

  it("allows only safe same-origin buyer navigation targets", () => {
    installStorefrontAssistantPageContextBridge();
    const bridge = window[STOREFRONT_ASSISTANT_BRIDGE_GLOBAL];
    const origin = window.location.origin;

    const allowedTargets = [
      "/products/widget",
      `${origin}/categories/rice`,
      "/collections/front-page",
      "/search?q=rice&sortBy=price-asc&brand=Premium%20Rice&phone-model=android&author=local&passion=spicy",
      "/cart",
      "/about-us",
    ];

    for (const target of allowedTargets) {
      expect(bridge?.navigate(target)).toBe(true);
    }

    expect(locationAssignMock.mock.calls.map(([target]) => target)).toEqual([
      "/products/widget",
      "/categories/rice",
      "/collections/front-page",
      "/search?q=rice&sortBy=price-asc&brand=Premium%20Rice&phone-model=android&author=local&passion=spicy",
      "/cart",
      "/about-us",
    ]);
  });

  it("rejects sensitive or non-buyer navigation targets without assigning location", () => {
    installStorefrontAssistantPageContextBridge();
    const bridge = window[STOREFRONT_ASSISTANT_BRIDGE_GLOBAL];
    const sameOriginWithCredentials = new URL(
      "/products/widget",
      window.location.origin,
    );
    sameOriginWithCredentials.username = "buyer";
    sameOriginWithCredentials.password = "secret";

    const rejectedTargets = [
      "products/widget",
      "//example.test/products/widget",
      "https://evil.example/products/widget",
      sameOriginWithCredentials.href,
      "/api/v1/products",
      "/admin",
      "/account",
      "/orders/status/cst_private_status",
      "/payment-recovery",
      "/checkout",
      "/buy/widget",
      "/private",
      "/products/private",
      "/products/widget?variant=var_default",
      "/search?receiptToken=chk_private_receipt",
      "/search?q=Bearer%20abc.def.ghi",
      "/search?q=buyer%40example.test",
      "/search?q=01711111111",
      "/search?q=rice#results",
      "/products\\widget",
      "/products/%5Csecret",
      "/products/../cart",
      "/products/%2e%2e/cart",
    ];

    for (const target of rejectedTargets) {
      expect(bridge?.navigate(target)).toBe(false);
    }

    expect(locationAssignMock).not.toHaveBeenCalled();
  });

  it("refreshes context without reloading when navigating to the current path", () => {
    window.history.replaceState(null, "", "/cart");
    installStorefrontAssistantPageContextBridge();
    const bridge = window[STOREFRONT_ASSISTANT_BRIDGE_GLOBAL];
    locationAssignMock.mockClear();

    expect(bridge?.navigate("/cart")).toBe(true);
    expect(locationAssignMock).not.toHaveBeenCalled();
    expect(bridge?.getContext()?.page.path).toBe("/cart");
    expect(window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL]?.page.path).toBe(
      "/cart",
    );
  });
});

describe("resolveStorefrontAssistantNavigationTarget", () => {
  it("normalizes same-origin absolute URLs to buyer-safe paths", () => {
    const origin = "https://shop.example.test";

    expect(
      resolveStorefrontAssistantNavigationTarget(
        "https://shop.example.test/products/widget",
        origin,
      ),
    ).toBe("/products/widget");
    expect(
      resolveStorefrontAssistantNavigationTarget(
        new URL("/search?q=rice", origin),
        origin,
      ),
    ).toBe("/search?q=rice");
  });
});
