import { lazy, Suspense, useState } from "react";
import { CircleHelp, Menu, Search } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { UserMenu, type UserMenuUser } from "@/components/auth/UserMenu";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { TOP_BAR_BUTTON } from "./nav-button";
import { ariaKeys, comboCaps, SHORTCUTS } from "./shortcuts";
import { StoreBadge, useStoreIdentity } from "./store-identity";
import { useShell } from "./shell";

// The bell and its list load after the shell.
const NotificationDropdown = lazy(() =>
  import("@/components/admin/NotificationDropdown").then((module) => ({ default: module.NotificationDropdown })),
);

const HelpMenu = lazy(() => import("./HelpMenu"));

/** The help button; the menu behind it loads on first use, and opens as soon as it has. */
function HelpButton({ label, onShortcuts }: { label: string; onShortcuts: () => void }) {
  const [asked, setAsked] = useState(false);
  const [open, setOpen] = useState(false);
  const trigger = (
    <button
      type="button"
      aria-label={label}
      onClick={asked ? undefined : () => { setAsked(true); setOpen(true); }}
      className={cn(TOP_BAR_BUTTON, "hidden md:flex")}
    >
      <CircleHelp aria-hidden />
    </button>
  );
  if (!asked) return trigger;
  return (
    <Suspense fallback={trigger}>
      <HelpMenu open={open} onOpenChange={setOpen} trigger={trigger} onShortcuts={onShortcuts} />
    </Suspense>
  );
}

/**
 * Shopify's top bar on the near-black frame: Menu on phones, one centred
 * search pill with its ⌘K caps, then help, notifications and the store menu.
 * While a form is dirty the contextual save bar takes the pill's exact place
 * and shape (`SaveBar` portals into `#admin-top-bar-pill`).
 */
export function AdminHeader({ user }: { user: UserMenuUser }) {
  const t = useMessages(shellMessages);
  const { drawerOpen, setDrawerOpen, setSearchOpen, setHelpOpen } = useShell();
  const store = useStoreIdentity();
  const storeLabel = store.name || store.host;
  return (
    <header
      data-slot="topbar"
      className="relative flex h-14 shrink-0 items-center gap-1 px-2 text-topbar-foreground md:grid md:grid-cols-[1fr_minmax(0,40rem)_1fr] md:gap-2 nav:ps-0 print:hidden"
    >
      {/* No min-w-0: the 1fr track keeps the Menu button's width, so the pill never covers it (768-1099px). */}
      <div className="flex">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label={t("toggleSidebar")}
          aria-expanded={drawerOpen}
          className={cn(TOP_BAR_BUTTON, "nav:hidden")}
        >
          <Menu aria-hidden />
        </button>
      </div>
      {/* The pill's box: the save bar covers it exactly (phones: the bar's full height). */}
      <div id="admin-top-bar-pill" className="flex min-w-0 flex-1 md:relative">
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-keyshortcuts={ariaKeys("search")}
          className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-topbar-border bg-topbar-subdued ps-3 pe-1.5 text-body text-topbar-foreground outline-none hover:bg-topbar-hover focus-visible:ring-2 focus-visible:ring-topbar-progress md:h-9"
        >
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="flex-1 truncate text-start">{t("search")}</span>
          <span className="hidden items-center gap-1 sm:flex" aria-hidden>
            {comboCaps(SHORTCUTS.search.combos[0]).map((cap) => (
              // 6px inside the 12px pill: 6px corners (concentric).
              <kbd key={cap} className="grid h-6 min-w-6 place-items-center rounded-md border-0 bg-topbar-hover px-1 text-caption text-topbar-foreground">
                {cap}
              </kbd>
            ))}
          </span>
        </button>
      </div>
      {/* No min-w-0: the 1fr track never goes under its content (the bell and store menu), so the pill gives way. */}
      <div className="flex items-center justify-end gap-1 md:pe-2">
        {/* Help, as Shopify's: its menu loads the first time it is asked for. */}
        <HelpButton onShortcuts={() => setHelpOpen(true)} label={t("help")} />
        <Suspense fallback={<span className="size-11 shrink-0 md:size-8" />}>
          <NotificationDropdown />
        </Suspense>
        {/* The store menu: badge and name, like Shopify's store switcher. */}
        <UserMenu user={user} side="bottom">
          <button type="button" aria-label={storeLabel || t("accountMenu")} className={cn(TOP_BAR_BUTTON, "min-w-0 gap-2 px-1.5")}>
            <StoreBadge name={store.name} className="size-7 rounded-lg md:size-6 md:rounded-md" />
            {storeLabel ? <span className="hidden max-w-40 truncate text-nav font-medium xl:inline">{storeLabel}</span> : null}
          </button>
        </UserMenu>
      </div>
    </header>
  );
}
