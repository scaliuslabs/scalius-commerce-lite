import { useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Link, useLocation, useNavigate, useRouteContext } from "@tanstack/react-router";
import { ChevronRight, Search } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Input } from "~/components/ui/input";
import { canAccessAdminPath } from "~/lib/admin-access";
import { useMessages } from "~/i18n";
import {
  settingsGroupMessages,
  settingsMessages,
  settingsNavMessages,
  settingsSummaryMessages,
} from "~/i18n/settings";
import { settingsSearchMessages } from "~/i18n/settings-search";
import { storeSettingsMessages } from "~/i18n/settings-store";
import { StoreBadge, useStoreIdentity } from "../layout/store-identity";
import { NAV_ROW } from "../layout/nav-button";
import { matchesPath } from "../layout/AdminNav";
import { SETTINGS_GROUPS, SETTINGS_NAV } from "./settings-nav";
import { searchSettings } from "./settings-search";

/**
 * The store's name and address, Shopify's store block: an unnamed store is
 * asked for its name, never shown as "Scalius". On the dark navigation panel
 * the badge sits on the right; on the phone list it leads.
 */
function StoreIdentity({ variant }: { variant: "sidebar" | "rows" }) {
  const t = useMessages(storeSettingsMessages);
  const store = useStoreIdentity();
  if (!store.canView) return null;
  const sidebar = variant === "sidebar";
  const name = store.name ? (
    <span className={cn("block truncate", sidebar ? "text-body font-medium" : "text-heading-sm")}>{store.name}</span>
  ) : !store.loaded ? null : (
    <Link
      to="/admin/settings/store"
      hash="business"
      className={cn("block truncate hover:underline", sidebar ? "text-body font-medium text-sidebar-foreground underline" : "text-heading-sm text-link")}
    >
      {t("addStoreName")}
    </Link>
  );
  const host = store.host ? (
    <span className={cn("block truncate text-body", sidebar ? "text-sidebar-muted-foreground" : "text-muted-foreground")}>{store.host}</span>
  ) : null;
  return sidebar ? (
    <div className="flex min-h-11 min-w-0 items-center gap-3 px-2">
      <span className="min-w-0 flex-1">
        {name}
        {host}
      </span>
      <StoreBadge name={store.name} className="size-8 rounded-lg text-body" />
    </div>
  ) : (
    <div className="flex min-h-9 min-w-0 items-center gap-3 px-2">
      <StoreBadge name={store.name} className="size-9 rounded-lg text-heading-sm" />
      <span className="min-w-0">
        {name}
        {host}
      </span>
    </div>
  );
}

/**
 * The settings list: search, store identity and the pages. Search matches
 * page names and the settings inside them ("COD", "courier", "VAT") and links
 * straight to the card. `variant="sidebar"` is the navigation panel that
 * replaces the main menu while settings are open (Shopify's order, flat);
 * `"rows"` is the phone list with summaries, in themed groups.
 */
export function SettingsNav({ variant, onNavigate }: { variant: "sidebar" | "rows"; onNavigate?: () => void }) {
  const context = useRouteContext({ from: "/admin" });
  const navigate = useNavigate();
  const path = useLocation({ select: (location) => location.pathname });
  const t = useMessages(settingsNavMessages);
  const common = useMessages(settingsMessages);
  const groups = useMessages(settingsGroupMessages);
  const summary = useMessages(settingsSummaryMessages);
  const search = useMessages(settingsSearchMessages);
  const [query, setQuery] = useState("");
  const sidebar = variant === "sidebar";
  const searching = query.trim() !== "";
  const found = searchSettings(query);
  const allowed = SETTINGS_NAV.filter((item) => canAccessAdminPath(item.to, context));
  const pages = allowed.filter((item) => found.pages.includes(item.key));
  const cards = found.cards.flatMap((entry) => {
    const page = allowed.find((item) => item.key === entry.page);
    return page ? [{ ...entry, to: page.to }] : [];
  });
  const shortcuts = found.shortcuts.filter((entry) => !("to" in entry) || canAccessAdminPath(entry.to, context));
  // Enter opens the first result, in the order shown.
  const first = pages[0]
    ? { to: pages[0].to }
    : cards[0]
      ? { to: cards[0].to, hash: cards[0].card }
      : shortcuts.flatMap((entry) => ("to" in entry ? [{ to: entry.to, hash: "hash" in entry ? entry.hash : undefined }] : []))[0];
  const sections = searching || sidebar
    ? [{ key: "pages", label: null, items: searching ? pages : allowed }]
    : SETTINGS_GROUPS.map((group) => ({
        key: group,
        label: groups(group),
        items: allowed.filter((item) => item.group === group),
      }));

  const field = {
    value: query,
    onChange: (event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter" || !searching || !first) return;
      event.preventDefault();
      onNavigate?.();
      void navigate(first);
    },
    placeholder: common("search"),
    "aria-label": common("search"),
  };
  const searchField = (
    <div className={cn("relative", !sidebar && "px-1")}>
      <Search
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2",
          sidebar ? "left-2 size-5 text-sidebar-muted-foreground" : "left-3.5 size-4 text-muted-foreground",
        )}
        aria-hidden="true"
      />
      {sidebar ? (
        <input
          type="search"
          {...field}
          className="h-11 w-full rounded-lg bg-sidebar-hover pl-9 pr-2 text-body-lg text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring sm:text-body md:h-8"
        />
      ) : (
        <Input
          type="search"
          {...field}
          // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
          className="pl-9"
        />
      )}
    </div>
  );
  const resultRow = sidebar ? "block rounded-lg px-2 py-1.5 text-sidebar-foreground outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring" : "flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-muted/50";
  const detail = sidebar ? "block text-body text-sidebar-muted-foreground" : "block text-body text-muted-foreground";

  return (
    <nav aria-label={t("settings")} className={sidebar ? "space-y-2" : "space-y-3"}>
      {sidebar ? searchField : <StoreIdentity variant="rows" />}
      {sidebar ? <StoreIdentity variant="sidebar" /> : searchField}
      {searching && pages.length === 0 && cards.length === 0 && shortcuts.length === 0 ? (
        <p role="status" className={cn("px-2.5 text-body", sidebar ? "text-sidebar-muted-foreground" : "text-muted-foreground")}>{search("noResults")}</p>
      ) : null}
      {sections.map((section) =>
        section.items.length === 0 ? null : sidebar ? (
          <ul key={section.key} className="flex flex-col gap-0.5">
            {section.items.map(({ key, to, icon: Icon }) => {
              // Prefix match: a page's own sub-routes (a message editor, a staff member) keep it highlighted.
              const current = matchesPath(path, to);
              return (
                <li key={key}>
                  <Link to={to} className={NAV_ROW} aria-current={current ? "page" : undefined} onClick={onNavigate}>
                    <Icon aria-hidden="true" />
                    <span className="truncate">{t(key)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <div key={section.key} className="space-y-1.5">
            {section.label ? <h2 className="px-1 text-body text-muted-foreground">{section.label}</h2> : null}
            <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card shadow-card">
              {section.items.map(({ key, to, icon: Icon }) => (
                <li key={key}>
                  <Link to={to} className="flex min-h-14 items-start gap-3 px-4 py-3 hover:bg-muted/50">
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-body font-medium">{t(key)}</span>
                      <span className="block text-body text-muted-foreground">{summary(key)}</span>
                    </span>
                    <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
      {cards.length > 0 || shortcuts.length > 0 ? (
        <div className="space-y-1">
          <h2 className={cn("px-2 text-body", sidebar ? "text-sidebar-muted-foreground" : "text-muted-foreground")}>{search("results")}</h2>
          <ul className={sidebar ? "space-y-0.5" : "divide-y divide-border overflow-hidden rounded-xl bg-card shadow-card"}>
            {cards.map(({ card, page, to }) => (
              <li key={card}>
                <Link to={to} hash={card} className={resultRow} onClick={onNavigate}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-medium">{search(card)}</span>
                    <span className={detail}>{t(page)}</span>
                  </span>
                  {sidebar ? null : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                </Link>
              </li>
            ))}
            {shortcuts.map((entry) => {
              const label = (
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-medium">{search(entry.card)}</span>
                  <span className={detail}>{search(entry.section)}</span>
                </span>
              );
              return (
                <li key={entry.card}>
                  {"to" in entry ? (
                    <Link to={entry.to} hash={"hash" in entry ? entry.hash : undefined} className={resultRow} onClick={onNavigate}>
                      {label}
                      {sidebar ? null : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                    </Link>
                  ) : (
                    // Language and light/dark mode live in the account menu; say where.
                    <div className={sidebar ? "block px-2 py-1.5 text-sidebar-foreground" : "flex min-h-14 items-center gap-3 px-4 py-3"}>{label}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}
