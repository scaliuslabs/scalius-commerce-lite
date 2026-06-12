import { useLocation } from "@tanstack/react-router";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { UserMenu } from "@/components/auth/UserMenu";
import { DarkModeToggle } from "@/components/ui/DarkModeToggle";
import { CacheNukeButton } from "@/components/admin/CacheNukeButton";
import { NotificationDropdown } from "@/components/admin/NotificationDropdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { generateAdminBreadcrumbs } from "@/lib/adminBreadCrumb";

interface AdminHeaderProps {
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    role: string | null;
    twoFactorEnabled: boolean;
    isSuperAdmin: boolean;
  };
}

export function AdminHeader({ user }: AdminHeaderProps) {
  const location = useLocation();
  const breadcrumbItems = generateAdminBreadcrumbs(location.pathname);

  return (
    <header className="h-14 shrink-0 border-b border-border px-3 sm:px-4 flex items-center justify-between bg-background transition-colors duration-200">
      <div className="flex items-center gap-2">
        <SidebarTrigger className="h-9 w-9 text-muted-foreground hover:text-foreground" />
        <Separator orientation="vertical" className="mr-1 h-4" />
        <Breadcrumb items={breadcrumbItems} />
      </div>

      <TooltipProvider>
        <div className="flex items-center">
          <div className="hidden md:flex items-center">
            <CacheNukeButton />
            <div className="h-5 w-px bg-border mx-2.5" />
            <NotificationDropdown />
            <div className="h-5 w-px bg-border mx-2.5" />
          </div>
          <DarkModeToggle />
          <div className="h-5 w-px bg-border mx-2.5" />
          <UserMenu user={user} />
        </div>
      </TooltipProvider>
    </header>
  );
}
