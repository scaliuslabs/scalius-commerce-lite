import { describe, expect, it } from "vitest";
import { stripNavigationResolution } from "@scalius/shared/navigation-target";

import { createResourceNavigationItem } from "./navigation-source";

describe("createResourceNavigationItem", () => {
  const category = {
    id: "cat_home",
    name: "Home & Living",
    slug: "home-living",
    type: "category" as const,
    url: "/categories/home-living",
  };

  it("shows a selected public resource immediately while keeping its ID authoritative", () => {
    const item = createResourceNavigationItem(category, { id: "nav_home" });

    expect(item).toMatchObject({
      id: "nav_home",
      target: {
        type: "resource",
        resourceType: "category",
        resourceId: "cat_home",
      },
      labelMode: "resource",
      lastKnownLabel: "Home & Living",
      resolution: {
        title: "Home & Living",
        href: "/categories/home-living",
        readiness: "ready",
        available: true,
      },
    });
    expect(stripNavigationResolution(item)).not.toHaveProperty("resolution");
  });

  it("normalizes a filtered resource query and custom label in the preview", () => {
    const item = createResourceNavigationItem(category, {
      id: "nav_blue_home",
      customLabel: "Blue homeware",
      query: "color=Blue&material=Cotton",
    });

    expect(item).toMatchObject({
      labelMode: "custom",
      customLabel: "Blue homeware",
      target: { query: "?color=Blue&material=Cotton" },
      resolution: {
        title: "Blue homeware",
        href: "/categories/home-living?color=Blue&material=Cotton",
      },
    });
  });
});
