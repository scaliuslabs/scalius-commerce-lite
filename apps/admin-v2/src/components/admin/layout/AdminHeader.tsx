import { lazy, Suspense, useEffect, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { DarkModeToggle } from "@/components/ui/DarkModeToggle";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { generateAdminBreadcrumbs } from "@/lib/adminBreadCrumb";

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

function HeaderActionsSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex h-9 items-center gap-2 px-1 text-muted-foreground/40"
    >
      <div className="h-8 w-8 rounded-md bg-muted/60" />
      <div className="h-5 w-px bg-border" />
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
      className="relative inline-flex items-center gap-3 rounded-lg px-2 py-1"
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

function DeferredAdminHeaderActions({ userId }: { userId: string }) {
  const ready = useDeferredHeaderActions();

  if (!ready) return <HeaderActionsSkeleton />;

  return (
    <Suspense fallback={<HeaderActionsSkeleton />}>
      <CacheNukeButton />
      <div className="h-5 w-px bg-border mx-2.5" />
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
          <div className="hidden min-w-[5.75rem] items-center justify-end md:flex">
            <DeferredAdminHeaderActions userId={user.id} />
          </div>
          <DarkModeToggle />
          <div className="h-5 w-px bg-border mx-2.5" />
          <DeferredUserMenu user={user} />
        </div>
      </TooltipProvider>
    </header>
  );
}
