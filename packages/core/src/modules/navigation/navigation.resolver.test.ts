import { describe, expect, it } from "vitest";

import type { NavigationTargetItem } from "@scalius/shared/navigation-target";
import {
  chunkNavigationResourceIds,
  resolveNavigationItemsForAdmin,
  resolveNavigationItemsForPublic,
  type NavigationResourceSnapshot,
} from "./navigation.resolver";

const resources = new Map<string, NavigationResourceSnapshot>([
  ["product:prod_live", {
    id: "prod_live",
    resourceType: "product",
    title: "Renamed trainer",
    route: "/products/new-canonical",
    readiness: "ready",
  }],
  ["category:cat_draft", {
    id: "cat_draft",
    resourceType: "category",
    title: "Private category",
    route: "/categories/private",
    readiness: "resource_draft_or_internal",
  }],
  ["page:page_trashed", {
    id: "page_trashed",
    resourceType: "page",
    title: "Old policy",
    route: "/old-policy",
    readiness: "resource_trashed",
  }],
]);

describe("navigation resource resolver", () => {
  it("follows current resource title and canonical route while preserving custom labels", () => {
    const items: NavigationTargetItem[] = [{
      id: "live",
      target: {
        type: "resource",
        resourceType: "product",
        resourceId: "prod_live",
        query: "?color=red",
      },
      labelMode: "resource",
      lastKnownLabel: "Old trainer",
    }, {
      id: "custom",
      target: { type: "resource", resourceType: "product", resourceId: "prod_live" },
      labelMode: "custom",
      customLabel: "Our pick",
    }];

    expect(resolveNavigationItemsForPublic(items, resources)).toEqual([
      {
        id: "live",
        title: "Renamed trainer",
        href: "/products/new-canonical?color=red",
      },
      {
        id: "custom",
        title: "Our pick",
        href: "/products/new-canonical",
      },
    ]);
  });

  it("omits unavailable leaves but keeps a useful parent as a label group", () => {
    const items: NavigationTargetItem[] = [{
      id: "draft-parent",
      target: { type: "resource", resourceType: "category", resourceId: "cat_draft" },
      labelMode: "resource",
      subMenu: [{
        id: "child",
        target: { type: "internal_path", path: "/contact" },
        labelMode: "custom",
        customLabel: "Contact",
      }],
    }, {
      id: "trashed-leaf",
      target: { type: "resource", resourceType: "page", resourceId: "page_trashed" },
      labelMode: "resource",
    }, {
      id: "missing-leaf",
      target: { type: "resource", resourceType: "product", resourceId: "prod_missing" },
      labelMode: "resource",
      lastKnownLabel: "Removed product",
    }];

    expect(resolveNavigationItemsForPublic(items, resources)).toEqual([{
      id: "draft-parent",
      title: "Private category",
      subMenu: [{ id: "child", title: "Contact", href: "/contact" }],
    }]);
    expect(resolveNavigationItemsForAdmin(items, resources)[2]?.resolution).toMatchObject({
      readiness: "resource_missing",
      available: false,
      title: "Removed product",
    });
  });

  it("chunks unique IDs below D1's 100-parameter ceiling", () => {
    const ids = Array.from({ length: 181 }, (_, index) => `resource_${index}`);
    ids.push("resource_0");
    expect(chunkNavigationResourceIds(ids).map((chunk) => chunk.length)).toEqual([90, 90, 1]);
  });

  it("binds identity to the resource ID across slug reuse and restore", () => {
    const item: NavigationTargetItem = {
      id: "original",
      target: { type: "resource", resourceType: "product", resourceId: "prod_original" },
      labelMode: "resource",
      lastKnownLabel: "Original product",
    };
    const replacementOnly = new Map<string, NavigationResourceSnapshot>([[
      "product:prod_replacement",
      {
        id: "prod_replacement",
        resourceType: "product",
        title: "Replacement",
        route: "/products/reused-slug",
        readiness: "ready",
      },
    ]]);
    expect(resolveNavigationItemsForPublic([item], replacementOnly)).toEqual([]);

    const restored = new Map(replacementOnly);
    restored.set("product:prod_original", {
      id: "prod_original",
      resourceType: "product",
      title: "Restored original",
      route: "/products/restored-original",
      readiness: "ready",
    });
    expect(resolveNavigationItemsForPublic([item], restored)).toEqual([{
      id: "original",
      title: "Restored original",
      href: "/products/restored-original",
    }]);
  });

  it("does not treat discovery exclusion as buyer-link unavailability", () => {
    const discoveryExcluded = new Map<string, NavigationResourceSnapshot>();
    discoveryExcluded.set("product:prod_discovery_hidden", {
      id: "prod_discovery_hidden",
      resourceType: "product",
      title: "Buyer-visible product",
      route: "/products/buyer-visible",
      readiness: "ready",
      noIndex: true,
      excludeFromSitemap: true,
    } as NavigationResourceSnapshot);

    expect(resolveNavigationItemsForPublic([{
      id: "visible",
      target: {
        type: "resource",
        resourceType: "product",
        resourceId: "prod_discovery_hidden",
      },
      labelMode: "resource",
    }], discoveryExcluded)).toHaveLength(1);
  });
});
