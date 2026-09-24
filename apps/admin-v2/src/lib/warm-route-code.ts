import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/**
 * The screens merchants open all day, by the path that guards them and the
 * route ids whose code they need (layout first). Their code is not in the
 * first download; it is fetched once the first page has settled, so the first
 * visit to each is as quick as a return visit. Only code: no data is read.
 */
export const EVERYDAY_ROUTES: ReadonlyArray<{ path: string; ids: readonly string[] }> = [
  { path: "/admin/orders", ids: ["/admin/orders/_list", "/admin/orders/_list/", "/admin/orders/$orderId/"] },
  { path: "/admin/products", ids: ["/admin/products/", "/admin/products/$productId/edit"] },
  { path: "/admin/customers", ids: ["/admin/customers/"] },
  { path: "/admin/inventory", ids: ["/admin/inventory/"] },
];

/** After the first page, a moment's quiet: never competes with its own reads. */
export const ROUTE_CODE_WARM_DELAY_MS = 2_000;

interface RouteChunkLoader {
  looseRoutesById: Record<string, unknown>;
  loadRouteChunk: (route: never) => Promise<void> | undefined;
}

export function warmEverydayRouteCode(router: RouteChunkLoader, canOpen: (path: string) => boolean): void {
  for (const { path, ids } of EVERYDAY_ROUTES) {
    if (!canOpen(path)) continue;
    for (const id of ids) {
      const route = router.looseRoutesById[id];
      // A failed fetch here only means the page loads its code when opened, as before.
      if (route) void router.loadRouteChunk(route as never)?.catch(() => {});
    }
  }
}

export function useWarmEverydayRouteCode(canOpen: (path: string) => boolean): void {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setTimeout(() => warmEverydayRouteCode(router, canOpen), ROUTE_CODE_WARM_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [router, canOpen]);
}
