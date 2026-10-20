// "Where this app appears" (Shopify's app details): every place the app puts
// something beyond its services, each one a link to it: its pages, resource
// cards, actions, Home cards and storefront sections, named where they show.
// Its providers and a feature's pages show with their row in the service
// cards instead. Built only from the app's description (its manifest);
// nothing runs.
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Card, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { appSurfacesMessages } from "~/i18n/app-surfaces";
import { shellMessages } from "~/i18n/shell";
import type { AppDetail } from "~/lib/api-query-options/apps";
import { APP_PLACEMENT_SECTION } from "../layout/AdminNav";
import { appPagePath } from "./ui/surfaces";

type Message = keyof (typeof appSurfacesMessages)["en"];
type ShellKey = keyof (typeof shellMessages)["en"];

export type AppearsGroup = "settings" | "navigation" | "resources" | "home" | "store";

/** One place the app appears: what it is, where, and the link to it (none while the app is inactive). */
export interface AppearsEntry {
  key: string;
  group: AppearsGroup;
  label: string;
  detail: { message: Message; section?: ShellKey; target?: string };
  to: string | null;
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
 * Every place the app appears, in Polaris list order: its settings pages,
 * navigation pages, resource cards and actions, Home cards, storefront
 * sections and blocks. They link only while the app is active (they answer
 * only then).
 */
export function appearsEntries(app: AppDetail): AppearsEntry[] {
  const active = app.status === "active";
  const live = (to: string) => (active ? to : null);
  // A feature's pages show with the feature.
  const featurePages = new Set(app.features.flatMap((feature) => feature.pages));
  const pages = app.admin.pages.filter((page) => !featurePages.has(page.id));
  const entries: AppearsEntry[] = [];
  for (const page of pages.filter((entry) => entry.placement === "settings")) {
    entries.push({ key: `page:${page.id}`, group: "settings", label: page.title, detail: { message: "settingsPage" }, to: live(appPagePath(app.id, page.id)) });
  }
  for (const page of pages.filter((entry) => entry.placement !== "settings")) {
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
  for (const component of app.storefront.components) {
    for (const target of component.targets) {
      const message: Message = target === "header.actions" || target === "footer.columns" ? `slot_${target}` : target === "page" ? "appPage" : "productBlock";
      entries.push({ key: `component:${component.type}:${target}`, group: "store", label: component.name, detail: { message }, to: live("/admin/online-store/theme") });
    }
  }
  return entries;
}

export function AppWhereItAppears({ app }: { app: AppDetail }) {
  const t = useMessages(appSurfacesMessages);
  const section = useMessages(shellMessages);
  const entries = appearsEntries(app);
  if (entries.length === 0) return null;
  const detailText = ({ detail }: AppearsEntry) => {
    const vars: Record<string, string> = {};
    if (detail.section) vars.section = section(detail.section);
    if (detail.target) vars.target = t(`target_${detail.target}` as Message);
    return t(detail.message, vars);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("appearsTitle")}</CardTitle>
        <CardDescription>{t(app.status === "active" ? "appearsDescription" : "appearsInactive")}</CardDescription>
      </CardHeader>
      {GROUP_ORDER.map((group) => {
        const items = entries.filter((entry) => entry.group === group);
        if (items.length === 0) return null;
        return (
          <section key={group} aria-labelledby={`appears-${group}`} className="border-t border-border">
            <h3 id={`appears-${group}`} className="px-4 pb-1 pt-3 text-body font-medium text-muted-foreground">{t(`appears_${group}`)}</h3>
            <ul className="pb-2">
              {items.map((entry) => {
                const detail = detailText(entry);
                const content = (
                  <span className="min-w-0 flex-1">
                    <span title={entry.label} className="block truncate text-body font-medium">{entry.label}</span>
                    <span title={detail} className="block truncate text-body text-muted-foreground">{detail}</span>
                  </span>
                );
                return (
                  <li key={entry.key}>
                    {entry.to ? (
                      <Link
                        to={entry.to}
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
