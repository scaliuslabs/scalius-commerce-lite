export const HOMEPAGE_WIDGET_PLACEMENT_SLOTS = [
  "top",
  "bottom",
  "before_collection",
  "after_collection",
] as const;

export const CONTENT_WIDGET_PLACEMENT_SLOTS = [
  "top",
  "bottom",
  "before_content",
  "after_content",
] as const;

export const SUPPORTED_WIDGET_PLACEMENT_SCOPES = [
  "homepage",
  "page",
  "product",
  "category",
] as const;

export type SupportedWidgetPlacementScopeValue =
  (typeof SUPPORTED_WIDGET_PLACEMENT_SCOPES)[number];

export type WidgetPlacementScopeValue =
  | "homepage"
  | "page"
  | "product"
  | "category"
  | "collection";

export type WidgetPlacementSlotValue =
  | (typeof HOMEPAGE_WIDGET_PLACEMENT_SLOTS)[number]
  | (typeof CONTENT_WIDGET_PLACEMENT_SLOTS)[number];

const homepageSlots = new Set<string>(HOMEPAGE_WIDGET_PLACEMENT_SLOTS);
const contentSlots = new Set<string>(CONTENT_WIDGET_PLACEMENT_SLOTS);
const supportedScopes = new Set<string>(SUPPORTED_WIDGET_PLACEMENT_SCOPES);

export function isSupportedWidgetPlacementScope(
  scope: string | null | undefined,
): scope is SupportedWidgetPlacementScopeValue {
  return !!scope && supportedScopes.has(scope);
}

export function isHomepageWidgetPlacementScope(
  scope: string | null | undefined,
): boolean {
  return scope === "homepage";
}

export function isWidgetCollectionSlot(
  slot: string | null | undefined,
): boolean {
  return slot === "before_collection" || slot === "after_collection";
}

export function isWidgetPlacementSlotAllowedForScope(
  scope: string | null | undefined,
  slot: string | null | undefined,
): boolean {
  if (!isSupportedWidgetPlacementScope(scope)) return false;
  if (!slot) return false;
  return isHomepageWidgetPlacementScope(scope)
    ? homepageSlots.has(slot)
    : contentSlots.has(slot);
}

export function getDefaultWidgetPlacementSlotForScope(
  scope: string | null | undefined,
): WidgetPlacementSlotValue {
  return isHomepageWidgetPlacementScope(scope) ? "top" : "before_content";
}

export function normalizeWidgetPlacementSlotForScope(
  scope: string | null | undefined,
  slot: string | null | undefined,
): WidgetPlacementSlotValue {
  return isWidgetPlacementSlotAllowedForScope(scope, slot)
    ? (slot as WidgetPlacementSlotValue)
    : getDefaultWidgetPlacementSlotForScope(scope);
}
