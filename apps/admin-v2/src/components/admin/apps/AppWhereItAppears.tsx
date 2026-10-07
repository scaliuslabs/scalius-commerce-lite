// "Where this app appears" (Shopify's app details): every place the app puts
// something, each one a link to it. The providers it offers open their setup
// where their capability lives; its pages, resource cards, actions, Home
// cards and storefront sections are named where they show. Built only from
// the app's description (its manifest); nothing runs.
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Card, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { appSurfacesMessages } from "~/i18n/app-surfaces";
import { settingsNavMessages } from "~/i18n/settings";
import { shellMessages } from "~/i18n/shell";
import type { AppDetail } from "~/lib/api-query-options/apps";
import { APP_PLACEMENT_SECTION } from "../layout/AdminNav";
import { PROVIDER_CAPABILITY, isAppProviderKind, providerHash } from "./app-capabilities";
import { AppIcon } from "./AppIcon";
import { appPagePath } from "./ui/surfaces";

type Message = keyof (typeof appSurfacesMessages)["en"];
type ShellKey = keyof (typeof shellMessages)["en"];
type SettingsPageKey = keyof (typeof settingsNavMessages)["en"];

export type AppearsGroup = "settings" | "navigation" | "resources" | "home" | "store";

/** One place the app appears: what it is, where, and the link to it (none while the place is inactive). */
export interface AppearsEntry {
  key: string;
  group: AppearsGroup;
  label: string;
  detail: { message: Message; vars?: Record<string, string>; kind?: string; page?: SettingsPageKey; section?: ShellKey; target?: string };
  to: string | null;
  hash?: string;
  search?: Record<string, string>;
  icon?: string | null;
}

/** Where a card's or action's resource lives in the dashboard (its list; the record differs per use). */
const TARGET_LIST: Readonly<Record<string, string>> = {
  product: "/admin/products",
  variant: "/admin/products",
  order: "/admin/orders",
  customer: "/admin/customers",
  category: "/admin/categories",
  collection: "/admin/collections",
  brand: "/admin/brands",
  page: "/admin/pages",
  return: "/admin/orders",
};

const GROUP_ORDER: readonly AppearsGroup[] = ["settings", "navigation", "resources", "home", "store"];

/**
 * Every place the app appears, in Polaris list order: settings (its providers
 * on their capability pages, its settings pages, its own settings), its
 * navigation pages, resource cards and actions, Home cards, storefront
 * sections and blocks. Pages, cards and sections link only while the app is
 * active (they answer only then); a provider's setup always links.
 */
export function appearsEntries(app: AppDetail): AppearsEntry[] {
  const active = app.status === "active";
  const live = (to: string) => (active ? to : null);
  const entries: AppearsEntry[] = [];
  for (const provider of app.providers) {
    if (!isAppProviderKind(provider.kind)) continue;
    const capability = PROVIDER_CAPABILITY[provider.kind];
    entries.push({
      key: `provider:${provider.id}`,
      group: "settings",
      label: provider.name,
      detail: { message: "providerIn", kind: provider.kind, page: capability.page },
      to: capability.to,
      hash: providerHash(provider.id),
      icon: provider.icon,
    });
  }
  for (const page of app.admin.pages.filter((entry) => entry.placement === "settings")) {
    entries.push({ key: `page:${page.id}`, group: "settings", label: page.title, detail: { message: "settingsPage" }, to: live(appPagePath(app.id, page.id)) });
  }
  if (app.settings.sections.length > 0) {
    entries.push({
      key: "settings",
      group: "settings",
      label: "",
      detail: { message: "appSettingsDetail" },
      to: `/admin/apps/${encodeURIComponent(app.id)}`,
      search: { tab: "settings" },
    });
  }
  for (const page of app.admin.pages.filter((entry) => entry.placement !== "settings")) {
    entries.push({
      key: `page:${page.id}`,
      group: "navigation",
      label: page.title,
      detail: { message: "navPage", section: APP_PLACEMENT_SECTION[page.placement] ?? "apps" },
      to: live(appPagePath(app.id, page.id)),
    });
  }
  for (const card of app.admin.cards) {
    entries.push({ key: `card:${card.id}`, group: "resources", label: card.title, detail: { message: "card", target: card.target }, to: live(TARGET_LIST[card.target] ?? "/admin") });
  }
  for (const action of app.admin.actions) {
    entries.push({
      key: `action:${action.id}`,
      group: "resources",
      label: action.label,
      detail: { message: action.bulk ? "bulkAction" : "action", target: action.target },
      to: live(TARGET_LIST[action.target] ?? "/admin"),
    });
  }
  for (const widget of app.admin.widgets) {
    entries.push({ key: `widget:${widget.id}`, group: "home", label: widget.title, detail: { message: "widget" }, to: live("/admin") });
  }
  for (const section of app.storefront.sections) {
    entries.push({ key: `section:${section.type}`, group: "store", label: section.name, detail: { message: "section" }, to: live("/admin/online-store/theme") });
  }
  for (const block of app.storefront.productBlocks) {
    entries.push({ key: `block:${block.type}`, group: "store", label: block.name, detail: { message: "productBlock" }, to: live("/admin/online-store/theme") });
  }
  return entries;
}

export function AppWhereItAppears({ app }: { app: AppDetail }) {
  const t = useMessages(appSurfacesMessages);
  const settingsPage = useMessages(settingsNavMessages);
  const section = useMessages(shellMessages);
  const entries = appearsEntries(app);
  const detailText = (entry: AppearsEntry) => {
    const { detail } = entry;
    const vars: Record<string, string> = { ...detail.vars };
    if (detail.kind && isAppProviderKind(detail.kind)) vars.kind = t(`kind_${detail.kind}`);
    if (detail.page) vars.page = settingsPage(detail.page);
    if (detail.section) vars.section = section(detail.section);
    if (detail.target) vars.target = t(`target_${detail.target}` as Message);
    return t(detail.message, vars);
  };
  const inactive = app.status !== "active" && entries.some((entry) => entry.to === null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("appearsTitle")}</CardTitle>
        <CardDescription>{t(entries.length === 0 ? "appearsNothing" : "appearsDescription")}</CardDescription>
      </CardHeader>
      {inactive ? <p className="px-4 pb-3 text-body text-muted-foreground">{t("appearsInactive")}</p> : null}
      {GROUP_ORDER.map((group) => {
        const items = entries.filter((entry) => entry.group === group);
        if (items.length === 0) return null;
        return (
          <section key={group} aria-labelledby={`appears-${group}`} className="border-t border-border">
            <h3 id={`appears-${group}`} className="px-4 pb-1 pt-3 text-body font-medium text-muted-foreground">{t(`appears_${group}`)}</h3>
            <ul className="pb-2">
              {items.map((entry) => {
                const label = entry.key === "settings" ? t("appSettings") : entry.label;
                const content = (
                  <>
                    {entry.icon !== undefined ? <AppIcon src={entry.icon} size="sm" /> : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-medium">{label}</span>
                      <span className="block truncate text-body text-muted-foreground">{detailText(entry)}</span>
                    </span>
                  </>
                );
                return (
                  <li key={entry.key}>
                    {entry.to ? (
                      <Link
                        to={entry.to}
                        hash={entry.hash}
                        search={entry.search as never}
                        className="flex min-h-12 items-center gap-3 px-4 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        {content}
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      </Link>
                    ) : (
                      <div className="flex min-h-12 items-center gap-3 px-4 py-2">{content}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </Card>
  );
}
