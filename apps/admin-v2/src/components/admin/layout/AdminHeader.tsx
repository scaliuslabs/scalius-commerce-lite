import { lazy, Suspense, useEffect, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { UserMenu } from "@/components/auth/UserMenu";
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
          <UserMenu user={user} />
        </div>
      </TooltipProvider>
    </header>
  );
}
