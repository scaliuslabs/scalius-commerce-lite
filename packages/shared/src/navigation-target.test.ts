import { describe, expect, it } from "vitest";

import {
  getNavigationItemHref,
  getNavigationItemLabel,
  parseNavigationQuery,
  stripNavigationResolution,
  type NavigationTargetItem,
} from "./navigation-target";

describe("typed navigation targets", () => {
  it("canonicalizes a resource query without accepting another path authority", () => {
    expect(parseNavigationQuery("?sortBy=newest&color=Warm White")).toEqual({
      ok: true,
      query: "?sortBy=newest&color=Warm+White",
    });
    expect(parseNavigationQuery("/products?sortBy=newest")).toMatchObject({ ok: false });
    expect(parseNavigationQuery("color=red#details")).toMatchObject({ ok: false });
    expect(parseNavigationQuery("https://example.com")).toMatchObject({ ok: false });
  });

  it("uses resolver projections for display but strips them from writes", () => {
    const item: NavigationTargetItem = {
      id: "nav_product",
      target: { type: "resource", resourceType: "product", resourceId: "prod_1" },
      labelMode: "resource",
      lastKnownLabel: "Old name",
      resolution: {
        title: "Current name",
        href: "/products/current-slug",
        readiness: "ready",
        available: true,
      },
    };

    expect(getNavigationItemLabel(item)).toBe("Current name");
    expect(getNavigationItemHref(item)).toBe("/products/current-slug");
    expect(stripNavigationResolution(item)).not.toHaveProperty("resolution");
  });

  it("normalizes safe custom paths without restoring copied resource hrefs", () => {
    expect(getNavigationItemHref({
      id: "contact",
      target: { type: "internal_path", path: "contact" },
      labelMode: "custom",
      customLabel: "Contact",
    })).toBe("/contact");
  });
});
