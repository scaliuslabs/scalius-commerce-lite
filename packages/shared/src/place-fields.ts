// The Bangladesh address adapter's place fields, apart from the place
// directory (places.ts) and markets (markets.ts) so that address and delivery
// code in the browser imports only these few lines.

/** The country whose addresses carry place ids (the City/Thana/Area adapter). */
export const DELIVERY_HIERARCHY_COUNTRY = "BD";

/** The Bangladesh address fields, top first: city (level 1), thana (`zone`, 2), area (3). */
export const DELIVERY_HIERARCHY_FIELDS = ["city", "zone", "area"] as const;
export type DeliveryHierarchyField = (typeof DELIVERY_HIERARCHY_FIELDS)[number];

/** The place level of a Bangladesh address field. */
export function deliveryHierarchyLevel(field: DeliveryHierarchyField): 1 | 2 | 3 {
  return (DELIVERY_HIERARCHY_FIELDS.indexOf(field) + 1) as 1 | 2 | 3;
}

/** The Bangladesh address field of a place level, or null for a level it does not have. */
export function deliveryHierarchyField(placeLevel: number): DeliveryHierarchyField | null {
  return DELIVERY_HIERARCHY_FIELDS[placeLevel - 1] ?? null;
}

/** The country whose addresses carry place ids (the City/Thana/Area adapter). */
export const PLACE_ADDRESS_COUNTRY = DELIVERY_HIERARCHY_COUNTRY;
