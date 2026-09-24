import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";

import type { NavigationTargetItem } from "@scalius/shared/navigation-target";
import {
  chunkNavigationResourceIds,
  loadNavigationResourceSnapshots,
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

  it("carries the photo of a linked category for mega-menu panels", () => {
    const withPhotos = new Map<string, NavigationResourceSnapshot>([
      ["category:cat_shoes", {
        id: "cat_shoes",
        resourceType: "category",
        title: "Shoes",
        route: "/categories/shoes",
        readiness: "ready",
        imageUrl: "https://media.example.com/shoes.webp",
      }],
      ["category:cat_bags", {
        id: "cat_bags",
        resourceType: "category",
        title: "Bags",
        route: "/categories/bags",
        readiness: "ready",
      }],
      ...resources,
    ]);
    const items: NavigationTargetItem[] = [{
      id: "shop",
      target: { type: "label" },
      labelMode: "custom",
      customLabel: "Shop",
      subMenu: [{
        id: "shoes",
        target: { type: "resource", resourceType: "category", resourceId: "cat_shoes" },
        labelMode: "resource",
      }, {
        id: "bags",
        target: { type: "resource", resourceType: "category", resourceId: "cat_bags" },
        labelMode: "resource",
      }, {
        id: "trainer",
        target: { type: "resource", resourceType: "product", resourceId: "prod_live" },
        labelMode: "resource",
      }],
    }];

    const [shop] = resolveNavigationItemsForPublic(items, withPhotos);
    expect(shop).not.toHaveProperty("imageUrl");
    expect(shop?.subMenu).toEqual([
      {
        id: "shoes",
        title: "Shoes",
        href: "/categories/shoes",
        imageUrl: "https://media.example.com/shoes.webp",
      },
      { id: "bags", title: "Bags", href: "/categories/bags" },
      { id: "trainer", title: "Renamed trainer", href: "/products/new-canonical" },
    ]);
    expect(shop?.subMenu?.[1]).not.toHaveProperty("imageUrl");
    expect(resolveNavigationItemsForAdmin(items, withPhotos)[0]?.subMenu?.[0])
      .not.toHaveProperty("imageUrl");
  });

  it("reads a category's photo only when it has one", async () => {
    const { db, sqlite } = createSqliteD1Database({ foreignKeys: true });
    try {
      const insert = sqlite.prepare(
        "INSERT INTO categories (id, name, slug, image_url, status) VALUES (?, ?, ?, ?, 'published')",
      );
      insert.run("cat_photo", "Shoes", "shoes", " https://media.example.com/shoes.webp ");
      insert.run("cat_blank", "Bags", "bags", "   ");
      insert.run("cat_none", "Hats", "hats", null);
      const item = (id: string): NavigationTargetItem => ({
        id,
        target: { type: "resource", resourceType: "category", resourceId: id },
        labelMode: "resource",
      });

      const snapshots = await loadNavigationResourceSnapshots(db, {
        navigation: [item("cat_photo"), item("cat_blank"), item("cat_none")],
      }, {});

      expect(snapshots.get("category:cat_photo")?.imageUrl)
        .toBe("https://media.example.com/shoes.webp");
      expect(snapshots.get("category:cat_blank")).not.toHaveProperty("imageUrl");
      expect(snapshots.get("category:cat_none")).not.toHaveProperty("imageUrl");
      expect(snapshots.get("category:cat_none")?.readiness).toBe("ready");
    } finally {
      sqlite.close();
    }
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
