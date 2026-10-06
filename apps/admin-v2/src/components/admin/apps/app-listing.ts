// The Apps page's filters (Shopify's Apps page): status views with counts,
// a search over name, tagline and category, and one category. Installed apps
// and first-party apps not bundled yet ("Available to install") share them.
import type { Locale } from "~/i18n";
import type { AppCategory, AppListing, AppSummary } from "~/lib/api-query-options/apps";
import { localizedApp } from "./app-text";

export type AppEntry = { kind: "installed"; app: AppSummary } | { kind: "available"; app: AppListing };

export const APP_VIEWS = ["all", "active", "inactive", "updates", "available"] as const;
export type AppView = (typeof APP_VIEWS)[number];

/** The one view besides All an app belongs to: an update waiting for approval outranks its status. */
export function appView(entry: AppEntry): Exclude<AppView, "all"> {
  if (entry.kind === "available") return "available";
  if (entry.app.needsApproval) return "updates";
  return entry.app.status === "active" ? "active" : "inactive";
}

export function appViewCounts(entries: readonly AppEntry[]): Record<AppView, number> {
  const counts: Record<AppView, number> = { all: entries.length, active: 0, inactive: 0, updates: 0, available: 0 };
  for (const entry of entries) counts[appView(entry)] += 1;
  return counts;
}

/** Every category the apps list, in the manifest's order. */
export function appCategories(entries: readonly AppEntry[], order: readonly AppCategory[]): AppCategory[] {
  const present = new Set(entries.flatMap((entry) => entry.app.categories));
  return order.filter((category) => present.has(category));
}

/**
 * Whether an app matches the search (every word, in its name, tagline,
 * description or category names, in the dashboard's language or English)
 * and the view and category.
 */
export function appMatches(
  entry: AppEntry,
  filters: { view: AppView; category: AppCategory | null; query: string },
  locale: Locale,
  categoryLabel: (category: AppCategory) => string,
): boolean {
  if (filters.view !== "all" && appView(entry) !== filters.view) return false;
  if (filters.category && !entry.app.categories.includes(filters.category)) return false;
  const words = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const shown = localizedApp(entry.app, locale);
  const haystack = [
    entry.app.name, shown.name, entry.app.tagline, shown.tagline, entry.app.description, shown.description,
    ...entry.app.categories.map(categoryLabel),
  ].filter(Boolean).join(" ").toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}
