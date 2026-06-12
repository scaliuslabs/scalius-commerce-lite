import { useEffect, useRef } from "react";
import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/admin/layout/AppSidebar";
import { AdminHeader } from "@/components/admin/layout/AdminHeader";
import { ThemeProvider } from "@/components/admin/layout/ThemeProvider";
import { PermissionProvider } from "@/contexts/PermissionContext";
import { Toaster } from "@/components/ui/sonner";
import { adminRouteGuard } from "~/lib/auth.fns";
import { useFirebaseInit } from "~/hooks/use-firebase-init";
import { ADMIN_ACCESS_DENIED_PATH, shouldAllowAdminPath } from "~/lib/admin-access";

export const Route = createFileRoute("/admin")({
  // Admin is behind auth, never crawled — skip SSR for faster client navigation
  ssr: false,
  beforeLoad: async ({ location }) => {
    // Auth + RBAC guard: redirects to /auth/setup, /auth/login, or /auth/two-factor as needed
    const authContext = await adminRouteGuard();
    if (!shouldAllowAdminPath(location.pathname, authContext.hasAdminAccess)) {
      throw redirect({ to: ADMIN_ACCESS_DENIED_PATH });
    }
    return authContext;
  },
  component: AdminLayout,
});

function AdminLayout() {
  const { user, permissions, isSuperAdmin } = Route.useRouteContext();

  // Initialize Firebase Cloud Messaging for push notifications
  useFirebaseInit(user?.id);

  // Scroll content area to top on route change
  const scrollRef = useRef<HTMLDivElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [pathname]);

  return (
    <ThemeProvider>
      <PermissionProvider permissions={permissions} isSuperAdmin={isSuperAdmin}>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset className="h-svh overflow-hidden">
            <AdminHeader user={user} />
            <div
              ref={scrollRef}
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
        <Toaster richColors closeButton position="top-right" />
      </PermissionProvider>
    </ThemeProvider>
  );
}
