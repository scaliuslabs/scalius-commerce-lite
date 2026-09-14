import type { StatusTone } from "~/components/admin/shell";
import type {
  NavigationItemDraft,
  NavigationMenuItemRow,
  NavigationMenuSummary,
  NavigationPlacementSetting,
} from "~/lib/api-functions/navigation-authority";

/**
 * Presentation model for the navigation authority screens.
 *
 * Everything here is pure so the publish/discard rules, the storefront slot
 * mapping, and the destination readiness copy can be asserted without mounting
 * the editor. The components must not re-derive these rules locally.
 */

export const SYSTEM_DESTINATIONS = [
  ["home", "Home"],
  ["catalog", "Catalog"],
  ["search", "Search"],
  ["account", "Customer account"],
  ["cart", "Cart"],
  ["checkout", "Checkout"],
  ["order_lookup", "Order lookup"],
] as const;

export const TARGET_LABELS: Record<NavigationMenuItemRow["targetType"], string> = {
  label: "Heading",
  system: "Store page",
  page: "Page",
  category: "Category",
  collection: "Collection",
  product: "Product",
  internal_path: "Store path",
  external_url: "Web address",
};

/** Resource-backed targets are the only ones that can go missing or be trashed. */
const RESOURCE_TARGET_TYPES = ["page", "category", "collection", "product"] as const;

export function isResourceTargetType(
  value: string,
): value is (typeof RESOURCE_TARGET_TYPES)[number] {
  return (RESOURCE_TARGET_TYPES as readonly string[]).includes(value);
}

/**
 * A resource item whose target row is gone (deleted or trashed) keeps its place
 * in the menu but cannot be published. The editor must show that, not hide it.
 */
export function isDestinationUnavailable(item: NavigationMenuItemRow): boolean {
  return isResourceTargetType(item.targetType) && !item.targetId;
}

export function destinationSummary(item: NavigationMenuItemRow): string {
  if (item.targetType === "label") return "Heading";
  if (item.targetType === "system") {
    return SYSTEM_DESTINATIONS.find(([key]) => key === item.targetValue)?.[1] ?? "Store page";
  }
  if (item.targetType === "internal_path" || item.targetType === "external_url") {
    return item.targetValue ?? TARGET_LABELS[item.targetType];
  }
  const label = TARGET_LABELS[item.targetType];
  return item.targetId ? label : `${label} unavailable`;
}

export function formatDateTime(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown date"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Dhaka",
      }).format(date);
}

export interface MenuPublishState {
  /** The menu has never been published, so nothing of it is live yet. */
  isUnpublished: boolean;
  /** Saved edits exist that the storefront is not showing. */
  hasDraftChanges: boolean;
  /**
   * Discard restores the live version. It only exists once something is live;
   * a menu that was never published has nothing to fall back to.
   */
  canDiscardDraft: boolean;
  badgeLabel: string;
  badgeTone: StatusTone;
}

/**
 * Draft state is `revision` vs `publishedRevision`; there is no local form
 * buffer. Item edits are already persisted, they are simply not live.
 */
export function getMenuPublishState(menu: {
  revision: number;
  publishedRevision: number | null;
}): MenuPublishState {
  if (menu.publishedRevision == null) {
    return {
      isUnpublished: true,
      hasDraftChanges: true,
      canDiscardDraft: false,
      badgeLabel: "Draft",
      badgeTone: "attention",
    };
  }
  if (menu.revision !== menu.publishedRevision) {
    return {
      isUnpublished: false,
      hasDraftChanges: true,
      canDiscardDraft: true,
      badgeLabel: "Draft changes",
      badgeTone: "attention",
    };
  }
  return {
    isUnpublished: false,
    hasDraftChanges: false,
    canDiscardDraft: false,
    badgeLabel: "Published",
    badgeTone: "success",
  };
}

export interface NavigationLocationSlot {
  surface: string;
  slot: string;
  position: number;
  label: string;
  description: string;
}

/** The storefront slots a menu can be assigned to, in storefront order. */
export const NAVIGATION_LOCATION_SLOTS: readonly NavigationLocationSlot[] = [
  {
    surface: "header",
    slot: "primary",
    position: 0,
    label: "Header",
    description: "Primary desktop and mobile menu",
  },
  ...Array.from({ length: 4 }, (_, position) => ({
    surface: "footer",
    slot: "column",
    position,
    label: `Footer column ${position + 1}`,
    description: "Footer link group",
  })),
];

export function locationSlotKey(slot: {
  surface: string;
  slot: string;
  position: number;
}): string {
  return `${slot.surface}:${slot.slot}:${slot.position}`;
}

export function findPlacementForSlot(
  placements: readonly NavigationPlacementSetting[],
  slot: { surface: string; slot: string; position: number },
): NavigationPlacementSetting | undefined {
  return placements.find(({ placement }) =>
    placement.surface === slot.surface
    && placement.slot === slot.slot
    && placement.position === slot.position);
}

/** The menu currently shown in a slot, or null when the slot is switched off. */
export function menuIdInSlot(
  placements: readonly NavigationPlacementSetting[],
  slot: { surface: string; slot: string; position: number },
): string | null {
  const found = findPlacementForSlot(placements, slot);
  if (!found || !found.placement.isEnabled) return null;
  return found.placement.menuId;
}

/** Slot labels a menu is live in, e.g. ["Header", "Footer column 2"]. */
export function menuLocationLabels(
  placements: readonly NavigationPlacementSetting[],
  menuId: string,
): string[] {
  return NAVIGATION_LOCATION_SLOTS
    .filter((slot) => menuIdInSlot(placements, slot) === menuId)
    .map((slot) => slot.label);
}

export function summarizeMenuLocations(labels: readonly string[]): {
  label: string;
  tone: StatusTone;
} {
  if (!labels.length) return { label: "Not used", tone: "neutral" };
  if (labels.length === 1) return { label: labels[0]!, tone: "info" };
  return { label: `${labels[0]!} +${labels.length - 1}`, tone: "info" };
}

/**
 * Placement writes are optimistic-concurrency controlled like every other
 * authority write, and the placement id is stable per slot so a slot that was
 * never saved can still be created from the same call.
 */
export function buildPlacementWrite(
  slot: NavigationLocationSlot,
  placement: NavigationPlacementSetting | undefined,
  menuId: string | null,
): {
  placementId: string;
  expectedRevision: number;
  surface: string;
  slot: string;
  position: number;
  menuId: string;
  labelOverride: string | null;
  isEnabled: boolean;
} | null {
  const current = placement?.placement;
  // Nothing saved and nothing to assign: there is no row to write.
  if (!menuId && !current) return null;
  const resolvedMenuId = menuId ?? current?.menuId;
  if (!resolvedMenuId) return null;
  return {
    placementId: current?.id ?? `placement_${slot.surface}_${slot.slot}_${slot.position}`,
    expectedRevision: current?.revision ?? 0,
    surface: slot.surface,
    slot: slot.slot,
    position: slot.position,
    menuId: resolvedMenuId,
    labelOverride: current?.labelOverride ?? null,
    isEnabled: Boolean(menuId),
  };
}

export type MenuSortValue = "updated" | "name" | "items";

export function sortMenuSummaries(
  menus: readonly NavigationMenuSummary[],
  sort: MenuSortValue,
): NavigationMenuSummary[] {
  const rows = [...menus];
  if (sort === "name") {
    return rows.sort((left, right) => left.name.localeCompare(right.name));
  }
  if (sort === "items") {
    return rows.sort((left, right) =>
      right.itemCount - left.itemCount || left.name.localeCompare(right.name));
  }
  return rows.sort((left, right) => {
    const rightTime = new Date(right.updatedAt).getTime();
    const leftTime = new Date(left.updatedAt).getTime();
    if (Number.isNaN(rightTime) || Number.isNaN(leftTime)) {
      return left.name.localeCompare(right.name);
    }
    return rightTime - leftTime || left.name.localeCompare(right.name);
  });
}

export function filterMenuSummaries(
  menus: readonly NavigationMenuSummary[],
  query: string,
): NavigationMenuSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...menus];
  return menus.filter((menu) =>
    menu.name.toLowerCase().includes(needle) || menu.handle.toLowerCase().includes(needle));
}

/**
 * Trashing a menu that a storefront slot still points at would blank that slot,
 * so the authority refuses it. Say which slots to clear first.
 */
export function describeMenuTrashBlock(placementCount: number): string | null {
  if (placementCount <= 0) return null;
  return `Remove it from ${placementCount} storefront ${
    placementCount === 1 ? "location" : "locations"
  } first, then try again.`;
}

export function itemRowToDraft(item: NavigationMenuItemRow): NavigationItemDraft {
  const base = {
    label: item.label,
    labelMode: item.labelMode,
    openInNewTab: item.openInNewTab,
    isEnabled: item.isEnabled,
  } as const;
  if (isResourceTargetType(item.targetType)) {
    return {
      ...base,
      target: {
        type: "resource",
        resourceType: item.targetType,
        resourceId: item.targetId ?? "",
        ...(item.targetQuery ? { query: item.targetQuery } : {}),
      },
    };
  }
  if (item.targetType === "system") {
    return {
      ...base,
      labelMode: "custom",
      target: {
        type: "system",
        key: (item.targetValue ?? "home") as Extract<
          NavigationItemDraft["target"],
          { type: "system" }
        >["key"],
      },
    };
  }
  if (item.targetType === "internal_path") {
    return {
      ...base,
      labelMode: "custom",
      target: { type: "internal_path", path: item.targetValue ?? "/" },
    };
  }
  if (item.targetType === "external_url") {
    return {
      ...base,
      labelMode: "custom",
      target: { type: "external_url", url: item.targetValue ?? "https://" },
    };
  }
  return { ...base, labelMode: "custom", target: { type: "label" } };
}

/** Deleting a parent takes its whole branch; say so before it happens. */
export function describeItemDeletion(label: string, childCount: number): string {
  if (childCount <= 0) return `"${label}" is removed from this menu.`;
  return `"${label}" and its ${childCount} nested ${
    childCount === 1 ? "item" : "items"
  } are removed from this menu.`;
}

export const MAX_MENU_DEPTH = 3;
