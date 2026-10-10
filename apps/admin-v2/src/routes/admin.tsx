import { lazy, Suspense, useCallback, useEffect, useMemo } from "react";
import { createFileRoute, Outlet, redirect, useMatchRoute } from "@tanstack/react-router";
import { AppSidebar } from "@/components/admin/layout/AppSidebar";
import { AdminHeader } from "@/components/admin/layout/AdminHeader";
import { AdminNavigationProgress } from "@/components/admin/layout/AdminNavigationProgress";
import { GlobalSearch } from "@/components/admin/layout/GlobalSearch";
import { ShellProvider } from "@/components/admin/layout/shell";
import { SETTINGS_ITEM, visibleNav } from "@/components/admin/layout/AdminNav";
import { useAppNavPages } from "@/components/admin/apps/ui/surfaces";
import { PermissionProvider } from "@/contexts/PermissionContext";
import { DeferredToaster } from "@/components/ui/deferred-toaster";
import { AdminSessionSync } from "@/components/auth/AdminSessionSync";
import {
  getAdminRouteContext,
  primeAdminRouteContextCache,
} from "~/lib/admin-route-context";
import {
  ADMIN_ACCESS_DENIED_PATH,
  canAccessAdminPath,
  getDefaultAdminPath,
  shouldAllowAdminPath,
} from "~/lib/admin-access";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { storefrontUrlQueryOptions } from "~/lib/api-query-options/storefront-url";
import { syncStoreDefaults } from "~/lib/api-query-options/store-defaults";
import { useWarmEverydayRouteCode } from "~/lib/warm-route-code";
import { useStoreReach, withoutUnusedPages } from "~/lib/store-reach";

// Asks the API what the store uses once the first page is up.
const StoreReachProbe = lazy(() => import("~/lib/store-reach-probe"));
const OfflineShell = lazy(() => import("@/components/admin/states/OfflineShell"));
// The live connection to the store's realtime hub (orders, inbox, presence),
// loaded when the browser is idle after the first page.
import { RealtimeLoader } from "@/components/admin/realtime/RealtimeLoader";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";

export const Route = createFileRoute("/admin")({
  beforeLoad: async ({ location }) => {
    // Auth + RBAC guard: redirects to /auth/setup, /auth/login, or /auth/two-factor as needed
    const authContext = await getAdminRouteContext();
    if (!shouldAllowAdminPath(location.pathname, authContext)) {
      if (location.pathname === "/admin") {
        const defaultPath = getDefaultAdminPath(authContext);
        if (defaultPath !== ADMIN_ACCESS_DENIED_PATH) {
          // `href` bypasses the router's base path handling; `to` is typed.
          throw redirect({ href: withDashboardBasePath(defaultPath) });
        }
      }
      throw redirect({ to: ADMIN_ACCESS_DENIED_PATH });
    }
    return authContext;
  },
  // The shell never shows a pending view: until its session guard answers,
  // the boot spinner stays; after that each page shows its own skeleton.
  pendingMs: Number.POSITIVE_INFINITY,
  // The navigation's "View store" eye and store row, and the store's time
  // zone and units (every date and weight): read alongside the page's own data.
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(storefrontUrlQueryOptions());
    void syncStoreDefaults(queryClient).catch(() => undefined);
  },
  component: AdminLayout,
});

function AdminLayout() {
  const authContext = Route.useRouteContext();
  const { user, permissions, isSuperAdmin } = authContext;
  const t = useMessages(shellMessages);

  useEffect(() => {
    primeAdminRouteContextCache(authContext);
  }, [authContext]);

  const canOpen = useCallback(
    (to: string) => canAccessAdminPath(to, { permissions, isSuperAdmin }),
    [permissions, isSuperAdmin],
  );
  // Active apps' pages join the section their placement names (apps.view only).
  const appPages = useAppNavPages(canOpen("/admin/apps"));
  const nav = useMemo(() => visibleNav(canOpen, appPages), [canOpen, appPages]);
  // Search finds every page; the sidebar lists the advanced ones (Price lists,
  // Translate & adapt) once the store uses them.
  const reach = useStoreReach();
  const sidebarNav = useMemo(() => withoutUnusedPages(nav, reach), [nav, reach]);
  useWarmEverydayRouteCode(canOpen);
  // The theme editor is a workspace of its own (Shopify's): the frame steps aside.
  // So is the new-store setup step (Shopify's "Tell us about your store").
  const matchRoute = useMatchRoute();
  const fullWindow = Boolean(matchRoute({ to: "/admin/online-store/theme/editor" }) || matchRoute({ to: "/admin/welcome" }));
  // Offline: the guard and banner load just after the first paint (states/OfflineShell).
  const offlineBanner = <Suspense fallback={null}><OfflineShell /></Suspense>;

  if (fullWindow) {
    return (
      <PermissionProvider permissions={permissions} isSuperAdmin={isSuperAdmin}>
        <AdminSessionSync />
        <RealtimeLoader userId={user.id} permissions={permissions} />
        <ShellProvider>
          <div className="flex h-svh flex-col">
            {offlineBanner}
            <div id="admin-main-scroll" tabIndex={-1} className="min-h-0 flex-1 overflow-clip outline-none">
              <Outlet />
            </div>
          </div>
        </ShellProvider>
        <DeferredToaster />
      </PermissionProvider>
    );
  }

  return (
    <PermissionProvider permissions={permissions} isSuperAdmin={isSuperAdmin}>
      <AdminSessionSync />
      <RealtimeLoader userId={user.id} permissions={permissions} />
      <ShellProvider>
        <a
          href="#admin-main-scroll"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById("admin-main-scroll")?.focus();
          }}
          className="sr-only z-50 rounded-lg bg-background text-body font-medium text-foreground focus:not-sr-only focus:fixed focus:inset-s-2 focus:top-2 focus:px-3 focus:py-2"
        >
          {t("skipToContent")}
        </a>
        <GlobalSearch nav={nav} canOpen={canOpen} />
        <Suspense fallback={null}>
          <StoreReachProbe languages={canOpen("/admin/translations")} priceLists={canOpen("/admin/price-lists")} />
        </Suspense>
        {/* Shopify's frame: the near-black navigation and top bar, and the
            page on a rounded canvas inset from them (square-cornered edge to
            edge on phones). The frame never scrolls: `main` is the only
            scroller and the containing block for anything absolutely
            positioned inside the page, so focus, dialogs and hidden inputs
            can't grow the document (clip, unlike hidden, can't be scrolled by
            focus either). */}
        <div className="flex h-svh overflow-clip bg-sidebar text-sidebar-foreground print:h-auto print:overflow-visible print:bg-transparent">
          <AppSidebar nav={sidebarNav} user={user} showSettings={canOpen(SETTINGS_ITEM.to)} />
          <div className="flex min-w-0 flex-1 flex-col">
            <AdminHeader user={user} />
            <div className="relative flex min-h-0 flex-1 flex-col overflow-clip rounded-t-xl bg-background text-foreground md:mb-2 md:ms-2 md:me-2 md:rounded-xl nav:ms-0 print:m-0 print:overflow-visible">
              <AdminNavigationProgress />
              {offlineBanner}
              <main
                id="admin-main-scroll"
                tabIndex={-1}
                data-scroll-restoration-id="admin-main-scroll"
                className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain outline-none lg:[scrollbar-gutter:stable] print:overflow-visible"
              >
                {/* Padding sits inside the scroller so sticky table headers meet the canvas' top edge. */}
                <div className="px-3 py-4 sm:px-4 md:px-6">
                  <div className="mx-auto max-w-7xl">
                    <Outlet />
                  </div>
                </div>
              </main>
              {/* Portal target for form action bars — sits outside the scroll area. */}
              <div id="form-action-bar-slot" className="bg-background" />
            </div>
          </div>
        </div>
      </ShellProvider>
      <DeferredToaster />
    </PermissionProvider>
  );
}
