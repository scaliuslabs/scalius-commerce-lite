import { useCallback, useEffect, useMemo } from "react";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppSidebar } from "@/components/admin/layout/AppSidebar";
import { AdminHeader } from "@/components/admin/layout/AdminHeader";
import { AdminNavigationProgress } from "@/components/admin/layout/AdminNavigationProgress";
import { GlobalSearch } from "@/components/admin/layout/GlobalSearch";
import { ShellProvider } from "@/components/admin/layout/shell";
import { SETTINGS_ITEM, visibleNav } from "@/components/admin/layout/AdminNav";
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
import { useWarmEverydayRouteCode } from "~/lib/warm-route-code";
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
  // The navigation's "View store" eye and store row: read alongside the page's own data.
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(storefrontUrlQueryOptions());
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
  const nav = useMemo(() => visibleNav(canOpen), [canOpen]);
  useWarmEverydayRouteCode(canOpen);

  return (
    <PermissionProvider permissions={permissions} isSuperAdmin={isSuperAdmin}>
      <AdminSessionSync />
      <ShellProvider>
        <a
          href="#admin-main-scroll"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById("admin-main-scroll")?.focus();
          }}
          className="sr-only z-50 rounded-lg bg-background text-body font-medium text-foreground focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:px-3 focus:py-2"
        >
          {t("skipToContent")}
        </a>
        <AdminNavigationProgress />
        <GlobalSearch nav={nav} canOpen={canOpen} />
        {/* Shopify's frame: the near-black navigation, and the page on a
            rounded canvas inset from it (edge to edge on phones). The frame
            never scrolls: `main` is the only scroller and the containing block
            for anything absolutely positioned inside the page, so focus,
            dialogs and hidden inputs can't grow the document (clip, unlike
            hidden, can't be scrolled by focus either). */}
        <div className="flex h-svh overflow-clip bg-sidebar">
          <AppSidebar nav={nav} user={user} showSettings={canOpen(SETTINGS_ITEM.to)} />
          <div className="flex min-w-0 flex-1 flex-col overflow-clip bg-background md:my-1.5 md:mr-1.5 md:rounded-xl">
            <AdminHeader nav={nav} />
            <main
              id="admin-main-scroll"
              tabIndex={-1}
              data-scroll-restoration-id="admin-main-scroll"
              className="relative min-h-0 min-w-0 flex-1 overflow-y-auto outline-none lg:[scrollbar-gutter:stable]"
            >
              {/* Padding sits inside the scroller so sticky table headers meet the top bar. */}
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
      </ShellProvider>
      <DeferredToaster />
    </PermissionProvider>
  );
}
