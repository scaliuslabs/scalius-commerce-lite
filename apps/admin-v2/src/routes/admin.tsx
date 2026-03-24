import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/admin/layout/AppSidebar";
import { AdminHeader } from "@/components/admin/layout/AdminHeader";
import { ThemeProvider } from "@/components/admin/layout/ThemeProvider";
import { PermissionProvider } from "@/contexts/PermissionContext";
import { Toaster } from "@/components/ui/sonner";
import { adminRouteGuard } from "~/lib/auth.fns";
import { useFirebaseInit } from "~/hooks/use-firebase-init";

export const Route = createFileRoute("/admin")({
  // Admin is behind auth, never crawled — skip SSR for faster client navigation
  ssr: false,
  beforeLoad: async () => {
    // Auth + RBAC guard: redirects to /auth/setup, /auth/login, or /auth/two-factor as needed
    const authContext = await adminRouteGuard();
    return authContext;
  },
  component: AdminLayout,
});

function AdminLayout() {
  const { user, permissions, isSuperAdmin } = Route.useRouteContext();

  // Initialize Firebase Cloud Messaging for push notifications
  useFirebaseInit(user?.id);

  return (
    <ThemeProvider>
      <PermissionProvider permissions={permissions} isSuperAdmin={isSuperAdmin}>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset className="h-svh overflow-hidden">
            <AdminHeader user={user} />
            <div className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 bg-gray-50 dark:bg-[#0a0a0a]">
              <div className="max-w-7xl mx-auto min-h-[50vh]">
                <Outlet />
              </div>
            </div>
            {/* Portal target for form action bars — sits OUTSIDE the scroll area */}
            <div id="form-action-bar-slot" />
          </SidebarInset>
        </SidebarProvider>
        <Toaster richColors closeButton />
      </PermissionProvider>
    </ThemeProvider>
  );
}
