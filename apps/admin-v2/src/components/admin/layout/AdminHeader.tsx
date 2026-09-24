import { lazy, Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import { UserMenu, type UserMenuUser } from "@/components/auth/UserMenu";
import logoDarkImg from "@/assets/logo-dark.png";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { GlobalSearch } from "./GlobalSearch";
import type { VisibleNavItem } from "./AdminNav";
import { TOP_BAR_BUTTON } from "./top-bar";
import { cn } from "@scalius/shared/utils";

// Push notifications pull in Firebase; keep them out of the shell chunk.
const NotificationDropdown = lazy(() =>
  import("@/components/admin/NotificationDropdown").then((module) => ({
    default: module.NotificationDropdown,
  })),
);

interface AdminHeaderProps {
  user: UserMenuUser;
  nav: VisibleNavItem[];
  canOpen: (path: string) => boolean;
  /** No menu button where the page has no sidebar (full-screen settings). */
  showMenu: boolean;
}

/**
 * The 56px top bar on the near-black frame: logo above the sidebar column, a
 * centred 640px search, notifications and the account menu. Its centre stays
 * free for the contextual save bar, which portals over the search.
 */
export function AdminHeader({ user, nav, canOpen, showMenu }: AdminHeaderProps) {
  const t = useMessages(shellMessages);
  const { toggleSidebar } = useSidebar();
  return (
    <header data-slot="topbar" className="relative z-20 flex h-14 shrink-0 items-center gap-2 bg-topbar px-2 text-topbar-foreground">
      {showMenu ? (
        <button type="button" onClick={toggleSidebar} aria-label={t("toggleSidebar")} className={cn(TOP_BAR_BUTTON, "md:hidden")}>
          <Menu className="size-5" aria-hidden />
        </button>
      ) : null}
      <Link to="/admin" className={cn(TOP_BAR_BUTTON, "hidden w-56 shrink-0 justify-start px-2 md:flex")}>
        <img src={withDashboardBasePath(logoDarkImg)} alt="Scalius" className="h-6 w-auto" />
      </Link>
      <div id="admin-top-bar-center" className="flex min-w-0 flex-1 justify-center">
        <GlobalSearch nav={nav} canOpen={canOpen} />
      </div>
      <Suspense fallback={<span className="size-11 md:size-9" />}>
        <NotificationDropdown userId={user.id} />
      </Suspense>
      <UserMenu user={user} />
    </header>
  );
}
