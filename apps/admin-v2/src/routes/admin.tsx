import { useEffect } from "react";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/admin/layout/AppSidebar";
import { AdminHeader } from "@/components/admin/layout/AdminHeader";
import { ThemeProvider } from "@/components/admin/layout/ThemeProvider";
import { PermissionProvider } from "@/contexts/PermissionContext";
import { DeferredToaster } from "@/components/ui/deferred-toaster";
import {
  getAdminRouteContext,
  primeAdminRouteContextCache,
} from "~/lib/admin-route-context";
import { useAdminNestedScrollRestoration } from "~/lib/admin-scroll-restoration";
import {
  ADMIN_ACCESS_DENIED_PATH,
  getDefaultAdminPath,
  shouldAllowAdminPath,
} from "~/lib/admin-access";

export const Route = createFileRoute("/admin")({
  beforeLoad: async ({ location }) => {
    // Auth + RBAC guard: redirects to /auth/setup, /auth/login, or /auth/two-factor as needed
    const authContext = await getAdminRouteContext();
    if (!shouldAllowAdminPath(location.pathname, authContext)) {
      if (location.pathname === "/admin") {
        const defaultPath = getDefaultAdminPath(authContext);
        if (defaultPath !== ADMIN_ACCESS_DENIED_PATH) {
          throw redirect({ href: defaultPath });
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

  useAdminNestedScrollRestoration();

  useEffect(() => {
    primeAdminRouteContextCache(authContext);
  }, [authContext]);

  return (
    <ThemeProvider>
      <PermissionProvider permissions={permissions} isSuperAdmin={isSuperAdmin}>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset className="h-svh overflow-hidden">
            <AdminHeader user={user} />
            <div
              id="admin-main-scroll"
              data-scroll-restoration-id="admin-main-scroll"
              className="flex-1 overflow-y-auto px-3 sm:px-4 md:px-6 pt-4 pb-4 bg-gray-50 dark:bg-[#0a0a0a]"
            >
              <div className="max-w-7xl mx-auto">
                <Outlet />
              </div>
            </div>
            {/* Portal target for form action bars — sits OUTSIDE the scroll area */}
            <div id="form-action-bar-slot" />
          </SidebarInset>
        </SidebarProvider>
        <DeferredToaster />
      </PermissionProvider>
    </ThemeProvider>
  );
}
