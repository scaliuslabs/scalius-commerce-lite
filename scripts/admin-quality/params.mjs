// Route parameters for the dashboard quality harness: one real id per
// resource, read from the API list endpoints with the signed-in session.
// The pure parts (the table and `pickId`) are tested; `resolveParams` takes
// the fetch function, so a test needs no server.

const firstOf = (data, keys) => {
  if (Array.isArray(data)) return data[0];
  for (const key of keys) if (Array.isArray(data?.[key])) return data[key][0];
  const any = Object.values(data ?? {}).find(Array.isArray);
  return any?.[0];
};

/** First row of a list response (`{ success, data: { <list>: [...] } }`) and its id. */
export function pickId(payload, { keys = [], id = (row) => row?.id } = {}) {
  const data = payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
  const row = firstOf(data, keys);
  const value = row === undefined || row === null ? null : id(row);
  return value === undefined || value === null || value === "" ? null : String(value);
}

const A = "/api/v1/admin";

/**
 * Param name -> where its value comes from. `needs` names params resolved
 * first (an object record lives under a type). `none` is the reason
 * shown when the store has no row.
 */
export const PARAM_SOURCES = {
  productId: { url: () => `${A}/products?limit=1`, keys: ["products"], none: "the store has no products" },
  orderId: { url: () => `${A}/orders?limit=1`, keys: ["orders"], none: "the store has no orders" },
  customerId: { url: () => `${A}/customers?limit=1`, keys: ["customers"], none: "the store has no customers" },
  categoryId: { url: () => `${A}/categories?limit=1`, keys: ["categories"], none: "the store has no categories" },
  collectionId: { url: () => `${A}/collections?limit=1`, keys: ["collections"], none: "the store has no collections" },
  brandId: { url: () => `${A}/brands?limit=1`, keys: ["brands"], none: "the store has no brands" },
  pageId: { url: () => `${A}/pages?contentType=page&limit=1`, keys: ["pages"], none: "the store has no pages" },
  articleId: { url: () => `${A}/pages?contentType=article&limit=1`, keys: ["pages"], none: "the store has no articles" },
  discountId: { url: () => `${A}/discounts?limit=1`, keys: ["discounts"], none: "the store has no discounts" },
  giftCardId: { url: () => `${A}/gift-cards?limit=1`, keys: ["items"], none: "the store has no gift cards" },
  priceListId: { url: () => `${A}/price-lists?limit=1`, keys: ["items"], none: "the store has no price lists" },
  conversationId: { url: () => `${A}/conversations?limit=1`, keys: ["items"], none: "the inbox is empty" },
  type: { url: () => `${A}/objects/types`, keys: ["items"], id: (row) => row?.handle, none: "the store has no object types" },
  recordId: {
    needs: ["type"],
    url: (values) => `${A}/objects/${encodeURIComponent(values.type)}?limit=1`,
    keys: ["records"],
    none: "the first object type has no records",
  },
  segmentId: { url: () => `${A}/customers/segments`, keys: ["segments"], none: "the store has no customer segments" },
  purchaseOrderId: { url: () => `${A}/inventory/purchase-orders?limit=1`, keys: ["purchaseOrders"], none: "the store has no purchase orders" },
  transferId: { url: () => `${A}/inventory/transfers?limit=1`, keys: ["transfers"], none: "the store has no stock transfers" },
  menuId: { url: () => `${A}/navigation/menus`, keys: ["items"], none: "the store has no menus" },
  marketId: { url: () => `${A}/settings/markets`, keys: ["items"], none: "the store has no markets" },
  userId: { url: () => `${A}/auth/users`, keys: ["users"], none: "no staff users" },
  roleId: { url: () => `${A}/rbac/roles`, keys: ["roles"], none: "no staff roles" },
  reportId: { url: () => `${A}/reports`, keys: ["reports"], none: "no reports" },
  pluginId: { url: () => `${A}/apps`, keys: ["apps"], none: "no apps installed" },
  checkoutId: { url: () => `${A}/abandoned-checkouts?limit=1`, keys: ["checkouts"], none: "the store has no abandoned checkouts" },
  event: {
    url: () => `${A}/settings/notification-channels/templates`,
    keys: [],
    id: () => "order_confirmed",
    fixed: "order_confirmed",
    none: "no notification templates",
  },
};

/** Params every route might use, resolved on demand. */
export async function resolveParams(names, getJson) {
  const resolved = {};
  const unresolved = {};
  const visit = async (name) => {
    if (name in resolved || name in unresolved) return;
    const source = PARAM_SOURCES[name];
    if (!source) {
      unresolved[name] = `no data source for :${name}`;
      return;
    }
    for (const need of source.needs ?? []) await visit(need);
    if ((source.needs ?? []).some((need) => !resolved[need])) {
      unresolved[name] = source.none;
      return;
    }
    if (source.fixed) {
      resolved[name] = source.fixed;
      return;
    }
    let payload = null;
    try {
      payload = await getJson(source.url(resolved));
    } catch {
      payload = null;
    }
    const value = pickId(payload, source);
    if (value) resolved[name] = value;
    else unresolved[name] = source.none;
  };
  for (const name of names) await visit(name);
  return { resolved, unresolved };
}
