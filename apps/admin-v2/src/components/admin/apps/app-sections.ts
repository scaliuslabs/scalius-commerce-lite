// The sections of an app's page (Stripe's and Shopify's settings shell): an
// Overview, one page per feature grouped by the kind of service it gives
// (Payments, Couriers, SMS, ...), the app's own Settings when it has any, and
// its Activity. Each has an address, /admin/apps/<app>/<section>, so a
// capability page's "Set up bKash" lands on bKash itself. An app without
// features keeps one page. Pure: the page and its links draw these.
import type { AppDetail, AppFeature } from "~/lib/api-query-options/apps";
import { serviceGroups, serviceHealth, serviceSettingKeys, type ServiceGroup, type ServiceHealth } from "./app-services";

/** The sections every app with features has, besides its features. */
export const BUILT_IN_SECTIONS = ["overview", "settings", "activity"] as const;
export type BuiltInSection = (typeof BUILT_IN_SECTIONS)[number];
/** Path segments the app page's other routes use (`/pages/<page>`). */
const RESERVED = new Set<string>([...BUILT_IN_SECTIONS, "pages"]);

export type AppSection =
  | { kind: BuiltInSection; key: BuiltInSection }
  | { kind: "feature"; key: string; feature: AppFeature; group: ServiceGroup; health: ServiceHealth };

/** A feature's section key: its id, unless the id is a built-in section's name. */
export function featureSectionKey(feature: Pick<AppFeature, "id">): string {
  return RESERVED.has(feature.id) ? `${feature.id}-feature` : feature.id;
}

/** Whether the app has fields of its own (not a feature's or a provider's): its Settings section. */
export function hasOwnSettings(app: AppDetail): boolean {
  const owned = serviceSettingKeys(app);
  return app.settings.fields.some((field) => !owned.has(field.key));
}

/** The app is drawn as sections only when it has features; otherwise it stays one page. */
export function usesSections(app: Pick<AppDetail, "features">): boolean {
  return app.features.length > 0;
}

/**
 * The navigation: Overview first, then the features by group (the order the
 * services cards use, recommended groups first), then Settings and Activity.
 */
export function appSectionNav(app: AppDetail): Array<{ group: ServiceGroup | null; sections: AppSection[] }> {
  const features = serviceGroups(app)
    .map(({ group, items }) => ({
      group,
      sections: items.flatMap((item): AppSection[] => item.kind === "feature"
        ? [{ kind: "feature", key: featureSectionKey(item.feature), feature: item.feature, group, health: serviceHealth(app, item) }]
        : []),
    }))
    .filter((entry) => entry.sections.length > 0);
  const tail: AppSection[] = [
    ...(hasOwnSettings(app) ? [{ kind: "settings", key: "settings" } as const] : []),
    { kind: "activity", key: "activity" },
  ];
  return [{ group: null, sections: [{ kind: "overview", key: "overview" }] }, ...features, { group: null, sections: tail }];
}

/**
 * The section a path segment names: a built-in section, a feature's key, or
 * (for links from a capability page, which know only the provider) the
 * feature that owns that provider id. Null when nothing matches.
 */
export function resolveAppSection(app: AppDetail, segment: string | undefined): AppSection | null {
  const all = appSectionNav(app).flatMap((entry) => entry.sections);
  const key = segment ?? "overview";
  const direct = all.find((section) => section.key === key);
  if (direct) return direct;
  const provider = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
  return all.find((section) => section.kind === "feature" && section.feature.request.providers.some((entry) => entry.id === provider)) ?? null;
}

/** Where a section lives: the app's own address for the overview. */
export function appSectionPath(pluginId: string, key: string): string {
  const base = `/admin/apps/${encodeURIComponent(pluginId)}`;
  return key === "overview" ? base : `${base}/${encodeURIComponent(key)}`;
}

/**
 * Where an app provider (`<plugin id>:<provider id>`) is set up: its feature's
 * page in the app (the app page resolves the provider to its feature, or its
 * overview when the provider runs with the app).
 */
export function appProviderSetupPath(providerId: string): string {
  const separator = providerId.indexOf(":");
  if (separator < 0) return "/admin/apps";
  return appSectionPath(providerId.slice(0, separator), providerId.slice(separator + 1));
}

