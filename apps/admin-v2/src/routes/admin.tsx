import { useCallback, useEffect, useMemo } from "react";
import { createFileRoute, Outlet, redirect, useLocation } from "@tanstack/react-router";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/admin/layout/AppSidebar";
import { AdminHeader } from "@/components/admin/layout/AdminHeader";
import { AdminNavigationProgress } from "@/components/admin/layout/AdminNavigationProgress";
import { SETTINGS_ITEM, matchesPath, visibleNav } from "@/components/admin/layout/AdminNav";
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
  component: AdminLayout,
});

function AdminLayout() {
  const authContext = Route.useRouteContext();
  const { user, permissions, isSuperAdmin } = authContext;
  // Settings is a full-screen view with its own navigation (Shopify style).
  const inSettings = useLocation({ select: (location) => matchesPath(location.pathname, SETTINGS_ITEM.to) });

  useEffect(() => {
    primeAdminRouteContextCache(authContext);
  }, [authContext]);

  const canOpen = useCallback(
    (to: string) => canAccessAdminPath(to, { permissions, isSuperAdmin }),
    [permissions, isSuperAdmin],
  );
  const nav = useMemo(() => visibleNav(canOpen), [canOpen]);

  return (
    <PermissionProvider permissions={permissions} isSuperAdmin={isSuperAdmin}>
      <AdminSessionSync />
      {/* The near-black frame: the top bar sits on it, and the light sheet
          (sidebar + page) is tucked under it with a 12px top-left corner. */}
      <SidebarProvider className="h-svh overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col bg-topbar">
        <AdminNavigationProgress />
        <AdminHeader user={user} nav={nav} canOpen={canOpen} showMenu={!inSettings} />
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-tl-xl bg-background">
          {inSettings ? null : <AppSidebar nav={nav} showSettings={canOpen(SETTINGS_ITEM.to)} />}
          <main
            id="admin-main-scroll"
            data-scroll-restoration-id="admin-main-scroll"
            className="min-w-0 flex-1 overflow-y-auto lg:[scrollbar-gutter:stable]"
          >
            {/* Padding sits inside the scroller so sticky table headers meet the top bar. */}
            <div className="px-3 py-4 sm:px-4 md:px-6">
              <div className="mx-auto max-w-7xl">
                <Outlet />
              </div>
            </div>
          </main>
        </div>
        {/* Portal target for form action bars — sits outside the scroll area. */}
        <div id="form-action-bar-slot" className="bg-background" />
        </div>
      </SidebarProvider>
      <DeferredToaster />
    </PermissionProvider>
  );
}
