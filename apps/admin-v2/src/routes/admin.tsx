import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Sidebar } from "@/components/admin/layout/Sidebar";
import { AdminHeader } from "@/components/admin/layout/AdminHeader";
import { ThemeProvider } from "@/components/admin/layout/ThemeProvider";
import { PermissionProvider } from "@/contexts/PermissionContext";
import { Toaster } from "@/components/ui/sonner";
import { adminRouteGuard } from "~/lib/auth.fns";

export const Route = createFileRoute("/admin")({
  beforeLoad: async () => {
    // Auth + RBAC guard: redirects to /auth/setup, /auth/login, or /auth/two-factor as needed
    const authContext = await adminRouteGuard();
    return authContext;
  },
  component: AdminLayout,
});

function AdminLayout() {
  const { user, permissions, isSuperAdmin } = Route.useRouteContext();
  return (
    <ThemeProvider>
      <PermissionProvider permissions={permissions} isSuperAdmin={isSuperAdmin}>
        <div className="flex min-h-screen">
          <Sidebar storefrontUrl="/" />

          <div className="flex flex-1 flex-col min-h-screen">
            <AdminHeader user={user} />

            <main className="flex-1 p-6 transition-colors duration-200 relative bg-gray-50 dark:bg-[#0a0a0a]">
              <div className="max-w-7xl mx-auto min-h-[50vh]">
                <Outlet />
              </div>
            </main>
          </div>
        </div>

        <Toaster richColors closeButton />
      </PermissionProvider>
    </ThemeProvider>
  );
}
