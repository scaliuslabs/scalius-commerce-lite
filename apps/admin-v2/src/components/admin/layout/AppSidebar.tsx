import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Eye, PanelLeft, Search, X } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { UserAvatar, UserMenu, type UserMenuUser } from "@/components/auth/UserMenu";
import markImg from "@/assets/favicon.png";
import { InboxNavBadge } from "~/components/admin/inbox/InboxNavBadge";
import { ReviewsNavBadge } from "~/components/admin/reviews/ReviewsNavBadge";
import { useMediaQuery } from "~/hooks/use-media-query";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { SETTINGS_ITEM, isSectionActive, matchesPath, type VisibleNavItem } from "./AdminNav";
import { SEARCH_KEYS, isMac } from "./GlobalSearch";
import { NAV_ICON_BUTTON, NAV_ROW } from "./nav-button";
import { ShellLink } from "./ShellLink";
import { StoreBadge, useStoreIdentity } from "./store-identity";
import { useShell } from "./shell";

// Push notifications pull in Firebase, the settings list its search index:
// both load after the shell.
const NotificationDropdown = lazy(() =>
  import("@/components/admin/NotificationDropdown").then((module) => ({ default: module.NotificationDropdown })),
);
const SettingsNav = lazy(() => import("../settings/SettingsNav").then((module) => ({ default: module.SettingsNav })));
const SidebarMobileSheet = lazy(() =>
  import("@/components/ui/sidebar-mobile-sheet").then((module) => ({ default: module.SidebarMobileSheet })),
);

const TOGGLE_KEYS = isMac ? "Meta+B" : "Control+B";

interface SidebarProps {
  nav: VisibleNavItem[];
  user: UserMenuUser;
  showSettings: boolean;
}

function historyIndex(state: unknown): number {
  const index = (state as { __TSR_index?: unknown } | null)?.__TSR_index;
  return typeof index === "number" ? index : 0;
}

function Mark() {
  return <img src={withDashboardBasePath(markImg)} alt="" className="size-6" />;
}

function Bell({ userId }: { userId: string }) {
  return (
    <Suspense fallback={<span className="size-11 shrink-0 md:size-8" />}>
      <NotificationDropdown userId={userId} />
    </Suspense>
  );
}

interface TipState {
  label: string;
  keys: boolean;
  x: number;
  y: number;
}

/**
 * One tooltip for the whole navigation, fixed to the right of the hovered or
 * keyboard-focused `data-tip` button (the frame clips its own overflow, so it
 * can't live inside): the button's accessible name and, for `data-tip="keys"`
 * (the collapse toggle), ⌘B.
 */
function useNavTooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const show = (event: PointerEvent | FocusEvent) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (event.type === "focus" && !target?.matches(":focus-visible")) return;
    if (!target) return setTip(null);
    const box = target.getBoundingClientRect();
    setTip({ label: target.getAttribute("aria-label") ?? "", keys: target.dataset.tip === "keys", x: box.right + 8, y: box.top + box.height / 2 });
  };
  const hide = () => setTip(null);
  const handlers = { onPointerOver: show, onPointerLeave: hide, onFocus: show, onBlur: hide, onClick: hide };
  const tooltip = tip ? (
    <span
      aria-hidden
      style={{ "--tip-x": `${tip.x}px`, "--tip-y": `${tip.y}px` } as CSSProperties}
      className="pointer-events-none fixed left-(--tip-x) top-(--tip-y) z-50 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-lg bg-popover px-2.5 py-1 text-body text-popover-foreground shadow-popover"
    >
      {tip.label}
      {tip.keys ? (
        <span className="flex gap-1">
          <kbd className="text-caption">{isMac ? "⌘" : "Ctrl"}</kbd>
          <kbd className="text-caption">B</kbd>
        </span>
      ) : null}
    </span>
  ) : null;
  return { handlers, tooltip };
}

/**
 * Shopify's navigation on the near-black frame. From md: a 240px panel (logo
 * and collapse button, Search, the sections, Settings and the store row) or,
 * collapsed with ⌘B, a 56px icon rail with tooltips; Settings swaps the panel
 * for the settings list beside the rail. On phones the same panel is a drawer.
 * The width eases between states and a new panel slides in; neither moves on
 * first paint.
 */
export function AppSidebar({ nav, user, showSettings }: SidebarProps) {
  const t = useMessages(shellMessages);
  const router = useRouter();
  const path = useLocation({ select: (location) => location.pathname });
  const { collapsed, drawerOpen, setDrawerOpen } = useShell();
  // One navigation is mounted at a time (its bell owns the push listener).
  const desktop = useMediaQuery("(min-width: 768px)");
  const inSettings = matchesPath(path, SETTINGS_ITEM.to);
  const panelKey = inSettings ? "settings" : collapsed ? null : "main";

  // Panels animate in only after the first change, never on page load.
  const firstPanel = useRef(panelKey);
  const [changed, setChanged] = useState(false);
  if (!changed && panelKey !== firstPanel.current) setChanged(true);

  // Where settings were entered from, so Back returns to that page.
  const settingsEntry = useRef<number | null>(null);
  useEffect(() => {
    settingsEntry.current = inSettings ? historyIndex(router.history.location.state) : null;
  }, [inSettings, router]);
  const leaveSettings = () => {
    const entry = settingsEntry.current ?? 0;
    if (entry > 0) router.history.go(entry - 1 - historyIndex(router.history.location.state));
    else void router.navigate({ to: "/admin" });
  };

  const { handlers, tooltip } = useNavTooltip();
  const closeDrawer = () => setDrawerOpen(false);
  const panel = (drawer: boolean) =>
    inSettings ? (
      <SettingsPanel user={user} onBack={leaveSettings} onClose={drawer ? closeDrawer : undefined} />
    ) : (
      <MainPanel nav={nav} user={user} showSettings={showSettings} onClose={drawer ? closeDrawer : undefined} />
    );

  if (!desktop) {
    return (
      <Suspense fallback={null}>
        <SidebarMobileSheet open={drawerOpen} onOpenChange={setDrawerOpen} label={inSettings ? t("settings") : t("mainNavigation")}>
          {panel(true)}
        </SidebarMobileSheet>
      </Suspense>
    );
  }
  return (
    <>
      <div
        {...handlers}
        data-nav=""
        data-nav-state={inSettings ? "settings" : collapsed ? "rail" : "panel"}
        className={cn(
          "flex h-full shrink-0 overflow-clip transition-[width] duration-200 ease-out",
          inSettings ? "w-74" : collapsed ? "w-14" : "w-60",
        )}
      >
        {inSettings || collapsed ? <Rail nav={nav} user={user} showSettings={showSettings} inSettings={inSettings} /> : null}
        {panelKey ? (
          <nav
            key={panelKey}
            aria-label={inSettings ? t("settings") : t("mainNavigation")}
            className={cn("flex h-full w-60 shrink-0 flex-col", changed && "motion-safe:animate-panel-in")}
          >
            {panel(false)}
          </nav>
        ) : null}
      </div>
      {tooltip}
    </>
  );
}

/** The panel's top row: the mark (home) and the collapse button, or Close in the phone drawer. */
function PanelTop({ onClose }: { onClose?: () => void }) {
  const t = useMessages(shellMessages);
  const { toggleCollapsed } = useShell();
  return (
    <div className="flex h-14 shrink-0 items-center justify-between px-3 md:mt-1.5">
      <ShellLink to="/admin" current={false} aria-label={t("home")} onClick={onClose} className={cn(NAV_ICON_BUTTON, "-ml-1")}>
        <Mark />
      </ShellLink>
      {onClose ? (
        <button type="button" onClick={onClose} aria-label={t("closeMenu")} className={NAV_ICON_BUTTON}>
          <X className="size-5" aria-hidden />
        </button>
      ) : (
        <button data-tip="keys" type="button" onClick={toggleCollapsed} aria-label={t("collapseNavigation")} aria-keyshortcuts={TOGGLE_KEYS} className={NAV_ICON_BUTTON}>
          <PanelLeft className="size-5" aria-hidden />
        </button>
      )}
    </div>
  );
}

function MainPanel({ nav, user, showSettings, onClose }: { nav: VisibleNavItem[]; user: UserMenuUser; showSettings: boolean; onClose?: () => void }) {
  const t = useMessages(shellMessages);
  const path = useLocation({ select: (location) => location.pathname });
  const { setSearchOpen } = useShell();
  const { storefrontUrl } = useStorefrontUrl();
  const ungrouped = nav.filter((item) => !item.group);
  const groups = [...new Set(nav.flatMap((item) => (item.group ? [item.group] : [])))];

  const renderItem = (item: VisibleNavItem) => {
    const open = isSectionActive(path, item);
    const activeChild = item.children.find((child) => matchesPath(path, child.to));
    return (
      <li key={item.key} className="group/item relative">
        <ShellLink
          to={item.to}
          preload="intent"
          current={open && !activeChild}
          onClick={onClose}
          className={cn(NAV_ROW, activeChild && "font-semibold")}
        >
          <item.icon aria-hidden />
          <span className="truncate">{t(item.key)}</span>
          {item.badge === "inbox" ? <InboxNavBadge /> : null}
        </ShellLink>
        {/* Shopify's eye on the Online store row: the storefront in a new tab. */}
        {item.key === "onlineStore" && storefrontUrl ? (
          <a
            href={storefrontUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("viewStore")}
            onClick={onClose}
            className={cn(NAV_ICON_BUTTON, "absolute right-0 top-0 opacity-0 focus-visible:opacity-100 group-hover/item:opacity-100 max-md:opacity-100")}
          >
            <Eye className="size-5" aria-hidden />
          </a>
        ) : null}
        {open && item.children.length > 0 ? (
          <ul data-nav-sub="" className="flex min-w-0 flex-col motion-safe:animate-nav-grow">
            {item.children.map((child) => (
              <li key={child.key}>
                <ShellLink
                  to={child.to}
                  preload="intent"
                  current={child === activeChild}
                  onClick={onClose}
                  className={cn(NAV_ROW, "pl-9 text-sidebar-muted-foreground")}
                >
                  <span className="truncate">{t(child.key)}</span>
                  {child.badge === "reviews" ? <ReviewsNavBadge /> : null}
                </ShellLink>
              </li>
            ))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <>
      <PanelTop onClose={onClose} />
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => {
            onClose?.();
            setSearchOpen(true);
          }}
          aria-keyshortcuts={SEARCH_KEYS}
          className="flex h-11 w-full items-center gap-2 rounded-lg bg-sidebar-hover px-2 text-body text-sidebar-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring md:h-8"
        >
          <Search className="size-5 shrink-0" aria-hidden />
          {t("search")}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <ul className="flex flex-col gap-0.5">{ungrouped.map(renderItem)}</ul>
        {groups.map((group) => (
          <div key={group} className="mt-4">
            <p className="flex h-7 items-center gap-1 px-2 text-body text-sidebar-muted-foreground">
              {t(group)}
              <ChevronRight className="size-3.5" aria-hidden />
            </p>
            <ul className="flex flex-col gap-0.5">{nav.filter((item) => item.group === group).map(renderItem)}</ul>
          </div>
        ))}
      </div>
      <div className="flex shrink-0 flex-col gap-0.5 px-3 pb-3">
        {showSettings ? (
          <ShellLink to={SETTINGS_ITEM.to} current={false} onClick={onClose} className={NAV_ROW}>
            <SETTINGS_ITEM.icon aria-hidden />
            <span className="truncate">{t("settings")}</span>
          </ShellLink>
        ) : null}
        <StoreRow user={user} />
      </div>
    </>
  );
}

/** Shopify's store row: the store badge and name open the account menu; the bell sits at the end. */
function StoreRow({ user }: { user: UserMenuUser }) {
  const t = useMessages(shellMessages);
  const store = useStoreIdentity();
  const label = store.name || store.host;
  return (
    <div className="flex items-center gap-1">
      <UserMenu user={user} side="top">
        <button type="button" aria-label={label ? undefined : t("accountMenu")} className={cn(NAV_ROW, "flex-1")}>
          <StoreBadge name={store.name} />
          <span className="truncate">{label}</span>
        </button>
      </UserMenu>
      <Bell userId={user.id} />
    </div>
  );
}

/** The collapsed navigation: every section as an icon with a tooltip, groups set apart by a rule. */
function Rail({ nav, user, showSettings, inSettings }: { nav: VisibleNavItem[]; user: UserMenuUser; showSettings: boolean; inSettings: boolean }) {
  const t = useMessages(shellMessages);
  const path = useLocation({ select: (location) => location.pathname });
  const { toggleCollapsed, setSearchOpen } = useShell();
  const store = useStoreIdentity();
  let lastGroup: string | undefined;
  return (
    <nav aria-label={t("mainNavigation")} className="flex h-full w-14 shrink-0 flex-col items-center gap-0.5 pb-3">
      <div className="flex h-14 shrink-0 items-center md:mt-1.5">
        {inSettings ? (
          <ShellLink to="/admin" current={false} aria-label={t("home")} className={NAV_ICON_BUTTON}>
            <Mark />
          </ShellLink>
        ) : (
          // The mark turns into the expand button under the pointer, as in Shopify.
          <button data-tip="keys" type="button" onClick={toggleCollapsed} aria-label={t("expandNavigation")} aria-keyshortcuts={TOGGLE_KEYS} className={cn(NAV_ICON_BUTTON, "group/expand")}>
            <span className="group-hover/expand:hidden group-focus-visible/expand:hidden">
              <Mark />
            </span>
            <PanelLeft className="hidden size-5 group-hover/expand:block group-focus-visible/expand:block" aria-hidden />
          </button>
        )}
      </div>
      <button data-tip="" type="button" onClick={() => setSearchOpen(true)} aria-label={t("search")} aria-keyshortcuts={SEARCH_KEYS} className={cn(NAV_ICON_BUTTON, "mb-2")}>
        <Search className="size-5" aria-hidden />
      </button>
      <ul className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto">
        {nav.map((item) => {
          const divider = item.group !== lastGroup;
          lastGroup = item.group;
          return (
            <li key={item.key} className="flex flex-col items-center">
              {divider ? <span aria-hidden className="my-2 h-px w-5 bg-sidebar-border" /> : null}
              <ShellLink data-tip="" to={item.to} preload="intent" current={!inSettings && isSectionActive(path, item)} aria-label={t(item.key)} className={NAV_ICON_BUTTON}>
                <item.icon className="size-5" aria-hidden />
              </ShellLink>
            </li>
          );
        })}
      </ul>
      {showSettings ? (
        <ShellLink data-tip="" to={SETTINGS_ITEM.to} current={inSettings} aria-label={t("settings")} className={NAV_ICON_BUTTON}>
          <SETTINGS_ITEM.icon className="size-5" aria-hidden />
        </ShellLink>
      ) : null}
      <Bell userId={user.id} />
      <UserMenu user={user} side="right">
        <button type="button" aria-label={store.name || t("accountMenu")} className={NAV_ICON_BUTTON}>
          <StoreBadge name={store.name} />
        </button>
      </UserMenu>
    </nav>
  );
}

/**
 * The settings takeover: Back and the title, then the settings list with its
 * search and the store block, and the signed-in user at the bottom.
 */
function SettingsPanel({ user, onBack, onClose }: { user: UserMenuUser; onBack: () => void; onClose?: () => void }) {
  const t = useMessages(shellMessages);
  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-1 px-3 md:mt-1.5">
        <button type="button" onClick={onBack} aria-label={t("back")} className={cn(NAV_ICON_BUTTON, "-ml-1")}>
          <ChevronLeft className="size-5" aria-hidden />
        </button>
        <h2 className="flex-1 text-heading-sm text-sidebar-foreground">{t("settings")}</h2>
        {onClose ? (
          <button type="button" onClick={onClose} aria-label={t("closeMenu")} className={NAV_ICON_BUTTON}>
            <X className="size-5" aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <Suspense fallback={null}>
          <SettingsNav variant="sidebar" onNavigate={onClose} />
        </Suspense>
      </div>
      <div className="shrink-0 border-t border-sidebar-border px-3 py-2">
        <UserMenu user={user} side="top">
          <button type="button" className={cn(NAV_ROW, "h-auto min-h-11 gap-3 py-1.5 md:h-auto")}>
            <UserAvatar user={user} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{user.name}</span>
              <span className="block truncate text-sidebar-muted-foreground">{user.email}</span>
            </span>
          </button>
        </UserMenu>
      </div>
    </>
  );
}
