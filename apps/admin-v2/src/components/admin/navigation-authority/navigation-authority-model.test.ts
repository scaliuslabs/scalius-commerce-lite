import { describe, expect, it } from "vitest";

import type {
  NavigationMenuItemRow,
  NavigationMenuSummary,
  NavigationPlacementSetting,
} from "~/lib/api-functions/navigation-authority";

import {
  NAVIGATION_LOCATION_SLOTS,
  buildPlacementWrite,
  describeItemDeletion,
  describeMenuTrashBlock,
  destinationSummary,
  filterMenuSummaries,
  getMenuPublishState,
  isDestinationUnavailable,
  itemRowToDraft,
  menuIdInSlot,
  menuLocationLabels,
  sortMenuSummaries,
  summarizeMenuLocations,
} from "./navigation-authority-model";

function itemRow(overrides: Partial<NavigationMenuItemRow> = {}): NavigationMenuItemRow {
  return {
    id: "item",
    menuId: "menu",
    parentId: null,
    position: 0,
    label: "Shop",
    labelMode: "custom",
    targetType: "internal_path",
    targetId: null,
    targetValue: "/shop",
    targetQuery: null,
    openInNewTab: false,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function menuSummary(overrides: Partial<NavigationMenuSummary> = {}): NavigationMenuSummary {
  return {
    id: "menu",
    name: "Header primary",
    handle: "header-primary",
    revision: 4,
    publishedRevision: 4,
    dependencyRevision: 1,
    updatedAt: "2026-01-02T10:00:00.000Z",
    deletedAt: null,
    itemCount: 3,
    placementCount: 1,
    ...overrides,
  };
}

function placement(
  overrides: Partial<NavigationPlacementSetting["placement"]> = {},
): NavigationPlacementSetting {
  return {
    placement: {
      id: "placement_header_primary_0",
      surface: "header",
      slot: "primary",
      position: 0,
      menuId: "menu",
      labelOverride: null,
      isEnabled: true,
      revision: 2,
      ...overrides,
    },
    menuName: "Header primary",
    menuDeletedAt: null,
    publishedRevision: 4,
    publicationItemCount: 3,
  };
}

describe("navigation authority publish state", () => {
  it("treats a menu that was never published as a draft with nothing to discard", () => {
    const state = getMenuPublishState({ revision: 2, publishedRevision: null });
    expect(state).toMatchObject({
      isUnpublished: true,
      hasDraftChanges: true,
      canDiscardDraft: false,
      badgeLabel: "Draft",
    });
  });

  it("offers discard only once a published version exists to fall back to", () => {
    const state = getMenuPublishState({ revision: 6, publishedRevision: 4 });
    expect(state).toMatchObject({
      hasDraftChanges: true,
      canDiscardDraft: true,
      badgeLabel: "Draft changes",
    });
  });

  it("reports a menu whose revision is live as published", () => {
    const state = getMenuPublishState({ revision: 4, publishedRevision: 4 });
    expect(state).toMatchObject({
      hasDraftChanges: false,
      canDiscardDraft: false,
      badgeLabel: "Published",
      badgeTone: "success",
    });
  });
});

describe("navigation destination readiness", () => {
  it("flags a resource item whose target row is gone", () => {
    const missing = itemRow({ targetType: "category", targetId: null });
    expect(isDestinationUnavailable(missing)).toBe(true);
    expect(destinationSummary(missing)).toBe("Category unavailable");
  });

  it("keeps a resolvable resource item unflagged", () => {
    const ready = itemRow({ targetType: "category", targetId: "cat_1" });
    expect(isDestinationUnavailable(ready)).toBe(false);
    expect(destinationSummary(ready)).toBe("Category");
  });

  it("never flags targets that carry their own value", () => {
    expect(isDestinationUnavailable(itemRow({ targetType: "internal_path" }))).toBe(false);
    expect(destinationSummary(itemRow({ targetType: "internal_path" }))).toBe("/shop");
    expect(destinationSummary(itemRow({ targetType: "system", targetValue: "cart" })))
      .toBe("Cart");
    expect(destinationSummary(itemRow({ targetType: "label" }))).toBe("Heading");
  });
});

describe("navigation item drafts", () => {
  it("keeps the source-following label mode for resource items", () => {
    const draft = itemRowToDraft(itemRow({
      targetType: "product",
      targetId: "prod_1",
      targetQuery: "?variant=2",
      labelMode: "resource",
    }));
    expect(draft).toMatchObject({
      labelMode: "resource",
      target: { type: "resource", resourceType: "product", resourceId: "prod_1", query: "?variant=2" },
    });
  });

  it("forces a custom label for targets that have no source title", () => {
    expect(itemRowToDraft(itemRow({ targetType: "system", targetValue: "cart", labelMode: "resource" })))
      .toMatchObject({ labelMode: "custom", target: { type: "system", key: "cart" } });
    expect(itemRowToDraft(itemRow({ targetType: "external_url", targetValue: "https://x.test" })))
      .toMatchObject({ target: { type: "external_url", url: "https://x.test" } });
  });
});

describe("navigation storefront locations", () => {
  it("lists the header slot first, then four footer columns", () => {
    expect(NAVIGATION_LOCATION_SLOTS.map((slot) => slot.label)).toEqual([
      "Header",
      "Footer column 1",
      "Footer column 2",
      "Footer column 3",
      "Footer column 4",
    ]);
  });

  it("treats a disabled placement as an empty slot", () => {
    const slots = [placement({ isEnabled: false })];
    expect(menuIdInSlot(slots, NAVIGATION_LOCATION_SLOTS[0]!)).toBeNull();
    expect(menuLocationLabels(slots, "menu")).toEqual([]);
  });

  it("reports every slot a menu fills", () => {
    const slots = [
      placement(),
      placement({
        id: "placement_footer_column_1",
        surface: "footer",
        slot: "column",
        position: 1,
      }),
    ];
    expect(menuLocationLabels(slots, "menu")).toEqual(["Header", "Footer column 2"]);
    expect(summarizeMenuLocations(menuLocationLabels(slots, "menu")))
      .toEqual({ label: "Header +1", tone: "info" });
    expect(summarizeMenuLocations([])).toEqual({ label: "Not used", tone: "neutral" });
  });

  it("creates a placement row for an unsaved slot and pins the revision when one exists", () => {
    const slot = NAVIGATION_LOCATION_SLOTS[1]!;
    expect(buildPlacementWrite(slot, undefined, "menu")).toMatchObject({
      placementId: "placement_footer_column_0",
      expectedRevision: 0,
      menuId: "menu",
      isEnabled: true,
    });
    expect(buildPlacementWrite(slot, placement({ revision: 7, menuId: "other" }), null))
      .toMatchObject({ expectedRevision: 7, menuId: "other", isEnabled: false });
  });

  it("writes nothing when an unsaved slot is unchecked", () => {
    expect(buildPlacementWrite(NAVIGATION_LOCATION_SLOTS[2]!, undefined, null)).toBeNull();
  });
});

describe("navigation menu list", () => {
  it("filters on name and handle", () => {
    const menus = [menuSummary(), menuSummary({ id: "b", name: "Footer help", handle: "help" })];
    expect(filterMenuSummaries(menus, "help").map((menu) => menu.id)).toEqual(["b"]);
    expect(filterMenuSummaries(menus, "header-").map((menu) => menu.id)).toEqual(["menu"]);
    expect(filterMenuSummaries(menus, "   ")).toHaveLength(2);
  });

  it("sorts by last updated, name, and item count", () => {
    const menus = [
      menuSummary({ id: "a", name: "Zulu", updatedAt: "2026-01-01T00:00:00.000Z", itemCount: 9 }),
      menuSummary({ id: "b", name: "Alpha", updatedAt: "2026-02-01T00:00:00.000Z", itemCount: 2 }),
    ];
    expect(sortMenuSummaries(menus, "updated").map((menu) => menu.id)).toEqual(["b", "a"]);
    expect(sortMenuSummaries(menus, "name").map((menu) => menu.id)).toEqual(["b", "a"]);
    expect(sortMenuSummaries(menus, "items").map((menu) => menu.id)).toEqual(["a", "b"]);
  });

  it("explains why an assigned menu cannot be trashed", () => {
    expect(describeMenuTrashBlock(0)).toBeNull();
    expect(describeMenuTrashBlock(1)).toContain("1 storefront location");
    expect(describeMenuTrashBlock(3)).toContain("3 storefront locations");
  });
});

describe("navigation item deletion copy", () => {
  it("names the branch that goes with the item", () => {
    expect(describeItemDeletion("Shop", 0)).toBe('"Shop" is removed from this menu.');
    expect(describeItemDeletion("Shop", 1)).toContain("1 nested item");
    expect(describeItemDeletion("Shop", 4)).toContain("4 nested items");
  });
});
