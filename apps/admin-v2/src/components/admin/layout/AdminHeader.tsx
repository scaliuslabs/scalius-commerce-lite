import { useLocation } from "@tanstack/react-router";
import { Menu, UserRound, type LucideIcon } from "lucide-react";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { settingsNavMessages } from "~/i18n/settings";
import { SETTINGS_NAV } from "../settings/settings-nav";
import { SETTINGS_ITEM, isSectionActive, matchesPath, type VisibleNavItem } from "./AdminNav";
import { useShell } from "./shell";

/** The current page's icon and name: a settings page, a section's sub-page, a section, or My account. */
function usePageTitle(nav: VisibleNavItem[]): { icon: LucideIcon; title: string } | null {
  const t = useMessages(shellMessages);
  const settings = useMessages(settingsNavMessages);
  const path = useLocation({ select: (location) => location.pathname });
  if (matchesPath(path, SETTINGS_ITEM.to)) {
    const page = SETTINGS_NAV.find((item) => matchesPath(path, item.to));
    return page ? { icon: page.icon, title: settings(page.key) } : { icon: SETTINGS_ITEM.icon, title: t("settings") };
  }
  if (matchesPath(path, "/admin/account")) return { icon: UserRound, title: t("accountTitle") };
  const section = nav.find((item) => isSectionActive(path, item));
  if (!section) return null;
  const child = section.children.find((item) => matchesPath(path, item.to));
  return { icon: section.icon, title: t(child?.key ?? section.key) };
}

/**
 * The canvas' slim top bar (Shopify's): the current page's icon and name, and
 * on phones the Menu button that opens the navigation drawer. Its centre is
 * where the contextual save bar appears.
 */
export function AdminHeader({ nav }: { nav: VisibleNavItem[] }) {
  const t = useMessages(shellMessages);
  const { drawerOpen, setDrawerOpen } = useShell();
  const page = usePageTitle(nav);
  return (
    <header data-slot="topbar" className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card px-2 md:px-4">
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label={t("toggleSidebar")}
        aria-expanded={drawerOpen}
        className="flex size-11 items-center justify-center rounded-lg text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring md:hidden"
      >
        <Menu className="size-5" aria-hidden />
      </button>
      {page ? (
        <p className="flex min-w-0 items-center gap-2 text-body font-medium text-foreground">
          <page.icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{page.title}</span>
        </p>
      ) : null}
    </header>
  );
}
