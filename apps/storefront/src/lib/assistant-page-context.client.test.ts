import { describe, expect, it } from "vitest";

import {
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL,
  buildStorefrontAssistantPageContext,
  type StorefrontAssistantPageContextSnapshot,
} from "./assistant-page-context";
import { publishStorefrontAssistantPageContext } from "./assistant-page-context.client";

describe("publishStorefrontAssistantPageContext", () => {
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
});
