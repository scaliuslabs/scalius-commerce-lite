import { lazy, Suspense, useEffect, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { DarkModeToggle } from "@/components/ui/DarkModeToggle";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { useHasPermission } from "@/contexts/PermissionContext";
import { generateAdminBreadcrumbs } from "@/lib/adminBreadCrumb";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";

const CacheNukeButton = lazy(() =>
  import("@/components/admin/CacheNukeButton").then((module) => ({
    default: module.CacheNukeButton,
  })),
);

const NotificationDropdown = lazy(() =>
  import("@/components/admin/NotificationDropdown").then((module) => ({
    default: module.NotificationDropdown,
  })),
);

const UserMenu = lazy(() =>
  import("@/components/auth/UserMenu").then((module) => ({
    default: module.UserMenu,
  })),
);

interface AdminHeaderUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string | null;
  twoFactorEnabled: boolean;
  isSuperAdmin: boolean;
}

interface AdminHeaderProps {
  user: AdminHeaderUser;
}

type IdleSchedulerWindow = Window & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout?: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function useDeferredHeaderActions() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;
    const markReady = () => {
      if (!cancelled) setReady(true);
    };

    const idleWindow = window as IdleSchedulerWindow;
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(markReady, {
        timeout: 2_000,
      });
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(handle);
      };
    }

    const timeout = window.setTimeout(markReady, 1_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, []);

  return ready;
}

function HeaderActionsSkeleton({
  showCacheAction,
}: {
  showCacheAction: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className="flex h-9 items-center gap-2 px-1 text-muted-foreground/40"
    >
      {showCacheAction ? (
        <>
          <div className="h-8 w-8 rounded-md bg-muted/60" />
          <div className="h-5 w-px bg-border" />
        </>
      ) : null}
      <div className="h-8 w-8 rounded-md bg-muted/60" />
      <div className="h-5 w-px bg-border" />
    </div>
  );
}

function getUserInitials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function UserMenuFallback({ user }: { user: AdminHeaderUser }) {
  return (
    <div
      aria-hidden="true"
      className="relative inline-flex h-11 items-center gap-3 rounded-lg px-2 sm:h-10"
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary ring-2 ring-primary/10">
        {getUserInitials(user.name)}
      </div>
      <span className="hidden text-sm font-medium text-foreground md:inline-block">
        {user.name}
      </span>
    </div>
  );
}

function DeferredAdminHeaderActions({
  userId,
  canManageCache,
}: {
  userId: string;
  canManageCache: boolean;
}) {
  const ready = useDeferredHeaderActions();

  if (!ready) {
    return <HeaderActionsSkeleton showCacheAction={canManageCache} />;
  }

  return (
    <Suspense
      fallback={<HeaderActionsSkeleton showCacheAction={canManageCache} />}
    >
      {canManageCache ? (
        <>
          <CacheNukeButton />
          <div className="h-5 w-px bg-border mx-2.5" />
        </>
      ) : null}
      <NotificationDropdown userId={userId} />
      <div className="h-5 w-px bg-border mx-2.5" />
    </Suspense>
  );
}

function DeferredUserMenu({ user }: { user: AdminHeaderUser }) {
  const ready = useDeferredHeaderActions();

  if (!ready) return <UserMenuFallback user={user} />;

  return (
    <Suspense fallback={<UserMenuFallback user={user} />}>
      <UserMenu user={user} />
    </Suspense>
  );
}

export function AdminHeader({ user }: AdminHeaderProps) {
  const currentPath = useLocation({
    select: (location) => location.pathname,
  });
  const breadcrumbItems = generateAdminBreadcrumbs(currentPath);
  const canManageCache = useHasPermission(
    ADMIN_PERMISSIONS.SETTINGS_CACHE_MANAGE,
  );

  return (
    <header className="h-14 shrink-0 border-b border-border px-3 sm:px-4 flex items-center justify-between bg-background transition-colors duration-200">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden sm:gap-2">
        <SidebarTrigger className="h-11 w-11 shrink-0 text-muted-foreground hover:text-foreground sm:h-9 sm:w-9" />
        <Separator orientation="vertical" className="h-4 shrink-0 sm:mr-1" />
        <Breadcrumb items={breadcrumbItems} />
      </div>

      <TooltipProvider>
        <div className="flex shrink-0 items-center">
          <div className="hidden min-w-[5.75rem] items-center justify-end md:flex">
            <DeferredAdminHeaderActions
              userId={user.id}
              canManageCache={canManageCache}
            />
          </div>
          <DarkModeToggle />
          <div className="h-5 w-px bg-border mx-2.5" />
          <DeferredUserMenu user={user} />
        </div>
      </TooltipProvider>
    </header>
  );
}
