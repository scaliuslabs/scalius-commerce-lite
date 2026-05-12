import type { ApiWidget, ApiWidgetPlacement } from "@/lib/api/types";

export type WidgetPlacementZone = {
  scope: string;
  slot: string;
  scopeId?: string | null;
  anchorId?: string | null;
};

const SLOT_ORDER: Record<string, number> = {
  top: 10,
  before_content: 20,
  before_collection: 30,
  after_collection: 40,
  after_content: 50,
  bottom: 60,
};

function isLivePlacement(placement: ApiWidgetPlacement): boolean {
  return placement.isActive && placement.deletedAt == null;
}

function matchesZone(
  placement: ApiWidgetPlacement,
  zone: WidgetPlacementZone,
): boolean {
  if (!isLivePlacement(placement)) return false;
  if (placement.scope !== zone.scope) return false;
  if (placement.slot !== zone.slot) return false;
  if (zone.scope !== "homepage" && !zone.scopeId) return false;
  if (
    (zone.slot === "before_collection" || zone.slot === "after_collection") &&
    !zone.anchorId
  ) {
    return false;
  }

  if (zone.scopeId !== undefined && (placement.scopeId ?? null) !== zone.scopeId) {
    return false;
  }

  if (zone.anchorId !== undefined && (placement.anchorId ?? null) !== zone.anchorId) {
    return false;
  }

  return true;
}

function firstMatchingPlacement(
  widget: ApiWidget,
  zone: WidgetPlacementZone,
): ApiWidgetPlacement | null {
  return (widget.placements ?? []).find((placement) => matchesZone(placement, zone)) ?? null;
}

export function getWidgetsForZone(
  widgets: ApiWidget[],
  zone: WidgetPlacementZone,
): ApiWidget[] {
  return widgets
    .map((widget) => ({ widget, placement: firstMatchingPlacement(widget, zone) }))
    .filter((item): item is { widget: ApiWidget; placement: ApiWidgetPlacement } =>
      item.placement !== null,
    )
    .sort((a, b) => {
      const slotDiff =
        (SLOT_ORDER[a.placement.slot] ?? 999) -
        (SLOT_ORDER[b.placement.slot] ?? 999);
      if (slotDiff !== 0) return slotDiff;

      const anchorDiff = (a.placement.anchorId ?? "").localeCompare(
        b.placement.anchorId ?? "",
      );
      if (anchorDiff !== 0) return anchorDiff;

      const orderDiff = a.placement.sortOrder - b.placement.sortOrder;
      if (orderDiff !== 0) return orderDiff;

      const nameDiff = a.widget.name.localeCompare(b.widget.name);
      return nameDiff !== 0 ? nameDiff : a.widget.id.localeCompare(b.widget.id);
    })
    .map((item) => item.widget);
}
