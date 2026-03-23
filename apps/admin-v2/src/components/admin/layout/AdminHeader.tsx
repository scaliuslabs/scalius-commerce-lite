import { useState, useEffect } from "react";
import { useLocation } from "@tanstack/react-router";
import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { UserMenu } from "@/components/auth/UserMenu";
import { DarkModeToggle } from "@/components/ui/DarkModeToggle";
import { CacheNukeButton } from "@/components/admin/CacheNukeButton";
import { NotificationDropdown } from "@/components/admin/NotificationDropdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { generateAdminBreadcrumbs } from "@/lib/adminBreadCrumb";
import {
  dispatchToggleMobile,
  dispatchToggleCollapse,
} from "./Sidebar";

interface AdminHeaderProps {
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    role: string;
    twoFactorEnabled: boolean;
    isSuperAdmin: boolean;
  };
}

export function AdminHeader({ user }: AdminHeaderProps) {
  const location = useLocation();
  const breadcrumbItems = generateAdminBreadcrumbs(location.pathname);

  // Track sidebar collapsed state so we can swap the icon
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const onCollapsed = () => setSidebarCollapsed(true);
    const onExpanded = () => setSidebarCollapsed(false);
    // The sidebar dispatches these after toggling
    const onToggle = () =>
      setSidebarCollapsed((prev) => !prev);

    window.addEventListener("toggleSidebarCollapse", onToggle);
    window.addEventListener("sidebarCollapsed", onCollapsed);
    window.addEventListener("sidebarExpanded", onExpanded);
    return () => {
      window.removeEventListener("toggleSidebarCollapse", onToggle);
      window.removeEventListener("sidebarCollapsed", onCollapsed);
      window.removeEventListener("sidebarExpanded", onExpanded);
    };
  }, []);

  return (
    <header className="h-14 border-b border-border px-4 flex items-center justify-between sticky top-0 z-30 backdrop-blur-sm bg-background/95 transition-colors duration-200">
      <div className="flex items-center gap-3">
        {/* Mobile hamburger */}
        <Button
          variant="ghost"
          size="icon"
          onClick={dispatchToggleMobile}
          aria-label="Toggle sidebar"
          className="md:hidden h-9 w-9 text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <Menu className="!w-5 !h-5" />
        </Button>

        {/* Desktop collapse toggle — icon swaps based on sidebar state */}
        <Button
          variant="ghost"
          size="icon"
          onClick={dispatchToggleCollapse}
          aria-label="Collapse sidebar"
          className="hidden md:flex h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className="!w-6 !h-6" />
          ) : (
            <PanelLeftClose className="!w-6 !h-6" />
          )}
        </Button>

        <Breadcrumb items={breadcrumbItems} />
      </div>

      <TooltipProvider>
        <div className="flex items-center">
          <CacheNukeButton />
          <div className="h-5 w-px bg-border mx-2.5" />
          <NotificationDropdown />
          <div className="h-5 w-px bg-border mx-2.5" />
          <DarkModeToggle />
          <div className="h-5 w-px bg-border mx-2.5" />
          <UserMenu user={user} />
        </div>
      </TooltipProvider>
    </header>
  );
}
