// The Apps page's search (Shopify's Apps page): every word of it in an
// app's name, tagline, description or category names, in the dashboard's
// language or English. Installed apps and the apps a store can add share it.
import type { Locale } from "~/i18n";
import type { AppCategory, AppListing, AppSummary } from "~/lib/api-query-options/apps";
import { localizedApp } from "./app-text";

export function appMatches(
  app: AppSummary | AppListing,
  query: string,
  locale: Locale,
  categoryLabel: (category: AppCategory) => string,
): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const shown = localizedApp(app, locale);
  const haystack = [
    app.name, shown.name, app.tagline, shown.tagline, app.description, shown.description,
    ...app.categories.map(categoryLabel),
  ].filter(Boolean).join(" ").toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}
