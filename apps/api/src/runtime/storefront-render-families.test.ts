import { describe, expect, it } from "vitest";
import { PUBLIC_API_CACHE_ROUTES } from "@scalius/shared/public-api-cache-routes";
import { classifyPublicRuntimePath } from "./public-app";

/**
 * Cold-start budget of a storefront page render. Every storefront page is one
 * batch of public cached reads, and the first read into a route family pays
 * that family's module initialisation in a fresh isolate. The buyer family
 * (orders, customer auth, agent contexts, discounts) cost about 30-50 ms of
 * CPU cold. A page render must never initialise it, so every batchable read
 * lives in a read-only family.
 */
const RENDER_FAMILIES = new Set(["config", "catalog", "content"]);

describe("storefront render route families", () => {
  it.each(PUBLIC_API_CACHE_ROUTES.map((route) => route.path))(
    "%s is served by a read-only family",
    (path) => {
      expect(RENDER_FAMILIES.has(classifyPublicRuntimePath(path) ?? "none")).toBe(true);
    },
  );

  it("keeps checkout settings with the layout, and checkout writes in the buyer family", () => {
    expect(classifyPublicRuntimePath("/api/v1/checkout/config")).toBe("config");
    expect(classifyPublicRuntimePath("/api/v1/storefront/layout")).toBe("config");
    expect(classifyPublicRuntimePath("/api/v1/orders")).toBe("buyer");
    expect(classifyPublicRuntimePath("/api/v1/customer-auth/session")).toBe("buyer");
  });
});
