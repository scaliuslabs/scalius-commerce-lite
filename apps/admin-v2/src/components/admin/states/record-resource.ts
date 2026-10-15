/**
 * Which record a detail route shows and where its list is, read from the
 * route's path: `/admin/gift-cards/$giftCardId` is a gift card whose list is
 * `/admin/gift-cards`. A not-found state names the record and links back to
 * that list (polish bar R2) without each route repeating it.
 */
export type RecordNoun =
  | "order" | "abandonedCheckout" | "product" | "collection" | "category" | "brand"
  | "customer" | "segment" | "discount" | "giftCard" | "purchaseOrder" | "transfer"
  | "priceList" | "page" | "blogPost" | "contentType" | "entry" | "menu"
  | "conversation" | "report" | "app" | "market" | "staff" | "role";

export interface RecordResource {
  noun: RecordNoun;
  /** The list route, with the route's own params when it needs them. */
  list: string;
}

/** Keyed by the route path up to its last `$param` segment. */
const RECORDS: Readonly<Record<string, RecordResource>> = {
  "/admin/orders": { noun: "order", list: "/admin/orders" },
  "/admin/orders/abandoned": { noun: "abandonedCheckout", list: "/admin/orders/abandoned" },
  "/admin/products": { noun: "product", list: "/admin/products" },
  "/admin/collections": { noun: "collection", list: "/admin/collections" },
  "/admin/categories": { noun: "category", list: "/admin/categories" },
  "/admin/brands": { noun: "brand", list: "/admin/brands" },
  "/admin/customers": { noun: "customer", list: "/admin/customers" },
  "/admin/customers/segments": { noun: "segment", list: "/admin/customers/segments" },
  "/admin/discounts": { noun: "discount", list: "/admin/discounts" },
  "/admin/gift-cards": { noun: "giftCard", list: "/admin/gift-cards" },
  "/admin/inventory/purchase-orders": { noun: "purchaseOrder", list: "/admin/inventory/purchase-orders" },
  "/admin/inventory/transfers": { noun: "transfer", list: "/admin/inventory/transfers" },
  "/admin/price-lists": { noun: "priceList", list: "/admin/price-lists" },
  "/admin/pages": { noun: "page", list: "/admin/pages" },
  "/admin/articles": { noun: "blogPost", list: "/admin/articles" },
  "/admin/objects": { noun: "contentType", list: "/admin/objects" },
  "/admin/objects/$type/records": { noun: "entry", list: "/admin/objects/$type" },
  "/admin/online-store/navigation": { noun: "menu", list: "/admin/online-store/navigation" },
  "/admin/inbox": { noun: "conversation", list: "/admin/inbox" },
  "/admin/analytics/reports": { noun: "report", list: "/admin/analytics/reports" },
  "/admin/apps": { noun: "app", list: "/admin/apps" },
  "/admin/settings/markets": { noun: "market", list: "/admin/settings/markets" },
  "/admin/settings/users": { noun: "staff", list: "/admin/settings/users" },
  "/admin/settings/users/roles": { noun: "role", list: "/admin/settings/users" },
};

/** The record a route path shows, or null for a page that is not one record. */
export function recordResource(fullPath: string): RecordResource | null {
  const segments = fullPath.replace(/\/+$/, "").split("/");
  let last = -1;
  segments.forEach((segment, index) => {
    if (segment.startsWith("$")) last = index;
  });
  if (last < 0) return null;
  return RECORDS[segments.slice(0, last).join("/")] ?? null;
}

/** The list address with the current route's params filled in. */
export function recordListHref(resource: RecordResource, params: Record<string, string>): string {
  return resource.list.replace(/\$(\w+)/g, (whole, name: string) => (params[name] ? encodeURIComponent(params[name]) : whole));
}
