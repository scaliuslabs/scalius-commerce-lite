// The discount list's views and sorts and the four discount types: the route
// tree validates URLs with these, so they stay free of the list and editor.
export const DISCOUNT_TABS = ["all", "active", "scheduled", "expired"] as const;
export type DiscountTab = (typeof DISCOUNT_TABS)[number];

export const DISCOUNT_SORTS = ["updated", "titleAsc", "titleDesc", "used", "usedAsc"] as const;
export type DiscountSort = (typeof DISCOUNT_SORTS)[number];

export const DISCOUNT_TYPES = ["products", "buy_get", "order", "shipping"] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];
