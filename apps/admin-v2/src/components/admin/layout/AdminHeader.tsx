import { lazy, Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { useSidebar } from "@/components/ui/sidebar";
import { Menu } from "lucide-react";
import { UserMenu, type UserMenuUser } from "@/components/auth/UserMenu";
import logoDarkImg from "@/assets/logo-dark.png";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { GlobalSearch } from "./GlobalSearch";
import type { VisibleNavItem } from "./AdminNav";

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
  showMenu: boolean;
}

/**
 * The black top bar: logo, centred search, notifications and the account
 * menu. Its centre stays free for the contextual save bar, which portals over
 * the search while a form has unsaved changes.
 */
export function AdminHeader({ user, nav, canOpen, showMenu }: AdminHeaderProps) {
  const t = useMessages(shellMessages);
  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 bg-neutral-950 px-2 text-white sm:px-3">
      {showMenu ? (
        <MenuButton label={t("toggleSidebar")} />
      ) : null}
      <Link to="/admin" className="hidden shrink-0 items-center md:flex md:w-48">
        <img src={withDashboardBasePath(logoDarkImg)} alt="Scalius" className="h-7 w-auto" />
      </Link>
      <div id="admin-top-bar-center" className="flex min-w-0 flex-1 justify-center">
        <GlobalSearch nav={nav} canOpen={canOpen} />
      </div>
      <Suspense fallback={<span className="h-11 w-11 sm:h-9 sm:w-9" />}>
        <NotificationDropdown userId={user.id} />
      </Suspense>
      <UserMenu user={user} />
    </header>
  );
}

function MenuButton({ label }: { label: string }) {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-label={label}
      className="flex h-11 w-11 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white md:hidden"
    >
      <Menu className="h-5 w-5" />
    </button>
  );
}
