import { useState } from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Search } from "lucide-react";
import { getApiV1AdminSettingsBusiness } from "@scalius/api-client/sdk";
import { Input } from "~/components/ui/input";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { canAccessAdminPath } from "~/lib/admin-access";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { storefrontUrlQueryOptions } from "~/lib/api-query-options/storefront-url";
import { useMessages } from "~/i18n";
import {
  settingsGroupMessages,
  settingsMessages,
  settingsNavMessages,
  settingsSummaryMessages,
} from "~/i18n/settings";
import { settingsSearchMessages } from "~/i18n/settings-search";
import { SETTINGS_GROUPS, SETTINGS_NAV } from "./settings-nav";
import { searchSettings } from "./settings-search";

function StoreIdentity() {
  const { hasPermission } = usePermissions();
  const enabled = hasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW);
  const business = useQuery({
    queryKey: queryKeys.settings.business(),
    queryFn: () => apiData(getApiV1AdminSettingsBusiness()),
    enabled,
  });
  const storefront = useQuery({ ...storefrontUrlQueryOptions(), enabled });
  const name = business.data?.companyName?.trim() || "Scalius";
  const url = (storefront.data as { storefrontUrl?: string } | undefined)?.storefrontUrl ?? "";
  return (
    <div className="flex min-w-0 items-center gap-3 px-2">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-heading-sm text-primary-foreground">
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-heading-sm">{name}</span>
        {url ? (
          <span className="block truncate text-body text-muted-foreground">{url.replace(/^https?:\/\//, "")}</span>
        ) : null}
      </span>
    </div>
  );
}

const SIDEBAR_LINK =
  "flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-body font-medium text-muted-foreground hover:bg-muted hover:text-foreground data-[status=active]:bg-muted data-[status=active]:text-foreground";

/**
 * The settings list: store identity, a search box and the pages in themed
 * groups. Search matches page names and the settings inside them ("COD",
 * "courier", "VAT") and links straight to the card. `variant="rows"` is the
 * phone list with summaries; `"sidebar"` is the persistent desktop column.
 */
export function SettingsNav({ variant }: { variant: "sidebar" | "rows" }) {
  const context = useRouteContext({ from: "/admin" });
  const t = useMessages(settingsNavMessages);
  const common = useMessages(settingsMessages);
  const groups = useMessages(settingsGroupMessages);
  const summary = useMessages(settingsSummaryMessages);
  const search = useMessages(settingsSearchMessages);
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const found = searchSettings(query);
  const allowed = SETTINGS_NAV.filter((item) => canAccessAdminPath(item.to, context));
  const pages = allowed.filter((item) => found.pages.includes(item.key));
  const cards = found.cards.flatMap((entry) => {
    const page = allowed.find((item) => item.key === entry.page);
    return page ? [{ ...entry, to: page.to }] : [];
  });
  const sections = searching
    ? [{ key: "pages", label: null, items: pages }]
    : SETTINGS_GROUPS.map((group) => ({
        key: group,
        label: groups(group),
        items: allowed.filter((item) => item.group === group),
      }));

  return (
    <nav aria-label={t("settings")} className="space-y-3">
      <StoreIdentity />
      <div className="relative px-1">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={common("search")}
          aria-label={common("search")}
          // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
          className="pl-9"
        />
      </div>
      {searching && pages.length === 0 && cards.length === 0 ? (
        <p role="status" className="px-2.5 text-body text-muted-foreground">{search("noResults")}</p>
      ) : null}
      {sections.map((section) =>
        section.items.length === 0 ? null : variant === "sidebar" ? (
          <div key={section.key} className="space-y-1">
            {section.label ? <h2 className="px-2.5 text-body text-muted-foreground">{section.label}</h2> : null}
            <ul className="space-y-0.5">
              {section.items.map(({ key, to, icon: Icon }) => (
                <li key={key}>
                  <Link to={to} className={SIDEBAR_LINK} activeProps={{ "aria-current": "page" }}>
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {t(key)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
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
      {cards.length > 0 ? (
        <div className="space-y-1">
          <h2 className="px-2.5 text-body text-muted-foreground">{search("results")}</h2>
          <ul className={variant === "sidebar" ? "space-y-0.5" : "divide-y divide-border overflow-hidden rounded-xl bg-card shadow-card"}>
            {cards.map(({ card, page, to }) => (
              <li key={card}>
                <Link
                  to={to}
                  hash={card}
                  className={
                    variant === "sidebar"
                      ? "block rounded-lg px-2.5 py-1.5 hover:bg-muted"
                      : "flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-muted/50"
                  }
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-medium">{search(card)}</span>
                    <span className="block text-body text-muted-foreground">{t(page)}</span>
                  </span>
                  {variant === "rows" ? <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}
