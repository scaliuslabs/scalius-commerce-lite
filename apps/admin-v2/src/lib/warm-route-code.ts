interface CodeEntry {
  path: string;
  ids: readonly string[];
  /** Code the route loads itself after its own chunk (a lazily imported page). */
  chunks?: ReadonlyArray<() => Promise<unknown>>;
}

/**
 * Every screen in the dashboard sidebar, by the path that guards it and the
 * route ids whose code it needs (layout first). Their code is not in the
 * first download; it is fetched once the first page has settled (this list
 * too: `use-warm-route-code.ts` loads it then), so the first
 * visit to each is as quick as a return visit. Only code: no data is read.
 * A sidebar item missing here fails warm-route-code.test.ts.
 */
export const EVERYDAY_ROUTES: ReadonlyArray<CodeEntry> = [
  { path: "/admin/orders", ids: ["/admin/orders/_list", "/admin/orders/_list/", "/admin/orders/$orderId/"] },
  { path: "/admin/inbox", ids: ["/admin/inbox/"] },
  { path: "/admin/products", ids: ["/admin/products/", "/admin/products/$productId/edit"] },
  { path: "/admin/collections", ids: ["/admin/collections/"] },
  { path: "/admin/categories", ids: ["/admin/categories/"] },
  { path: "/admin/brands", ids: ["/admin/brands/"] },
  { path: "/admin/price-lists", ids: ["/admin/price-lists/"] },
  { path: "/admin/inventory", ids: ["/admin/inventory/"] },
  { path: "/admin/inventory/purchase-orders", ids: ["/admin/inventory/purchase-orders/"] },
  { path: "/admin/inventory/transfers", ids: ["/admin/inventory/transfers/"] },
  { path: "/admin/attributes", ids: ["/admin/attributes"] },
  { path: "/admin/reviews", ids: ["/admin/reviews/"] },
  { path: "/admin/gift-cards", ids: ["/admin/gift-cards/"] },
  { path: "/admin/customers", ids: ["/admin/customers/"] },
  { path: "/admin/customers/segments", ids: ["/admin/customers/segments/"] },
  { path: "/admin/discounts", ids: ["/admin/discounts/"] },
  { path: "/admin/pages", ids: ["/admin/pages/"] },
  { path: "/admin/articles", ids: ["/admin/articles/"] },
  {
    path: "/admin/media",
    ids: ["/admin/media"],
    // The route lazy-loads its page: without this, the first click fetches the
    // route's code, then the page's, one after the other.
    chunks: [() => import("~/components/admin/media-manager/MediaManagerPage")],
  },
  { path: "/admin/objects", ids: ["/admin/objects/"] },
  { path: "/admin/translations", ids: ["/admin/translations/"] },
  { path: "/admin/analytics", ids: ["/admin/analytics/"] },
  { path: "/admin/analytics/reports", ids: ["/admin/analytics/reports/"] },
  { path: "/admin/apps", ids: ["/admin/apps/"] },
  { path: "/admin/online-store/theme", ids: ["/admin/online-store/theme"] },
  { path: "/admin/online-store/navigation", ids: ["/admin/online-store/navigation/"] },
  { path: "/admin/online-store/preferences", ids: ["/admin/online-store/preferences"] },
  { path: "/admin/settings", ids: ["/admin/settings", "/admin/settings/"] },
];

interface RouteChunkLoader {
  routesById: object;
  loadRouteChunk: (route: never) => Promise<void> | undefined;
}

export function warmEverydayRouteCode(
  router: RouteChunkLoader,
  canOpen: (path: string) => boolean,
  routes: ReadonlyArray<CodeEntry> = EVERYDAY_ROUTES,
): void {
  for (const { path, ids, chunks } of routes) {
    if (!canOpen(path)) continue;
    // A failed fetch here only means the page loads its code when opened, as before.
    for (const load of chunks ?? []) void load().catch(() => {});
    for (const id of ids) {
      const route = (router.routesById as Record<string, unknown>)[id];
      if (route) void router.loadRouteChunk(route as never)?.catch(() => {});
    }
  }
}
