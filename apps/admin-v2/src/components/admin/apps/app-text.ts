// An app's own words in the dashboard's language. The manifest is English;
// its `translations` carry the name, description and surface titles by
// BCP 47 tag (what is missing stays English). The app's screens themselves come
// in the dashboard's language from the app (`adminContext().locale`).
import type { Locale } from "~/i18n";
import type { AppAdminSurfaces, AppSummary } from "~/lib/api-query-options/apps";

type Translations = AppSummary["translations"];
type Translation = NonNullable<Translations>[string];

/**
 * The app's text in the dashboard's language: the exact tag (`pt-BR`), then
 * its language (`pt`). English is the manifest itself, so it has no entry.
 */
export function translationFor(translations: Translations | undefined, locale: string): Translation | null {
  if (!translations || locale === "en") return null;
  const wanted = locale.toLowerCase();
  const tags = Object.keys(translations);
  const exact = tags.find((tag) => tag.toLowerCase() === wanted);
  if (exact) return translations[exact] ?? null;
  const language = wanted.split("-")[0]!;
  const base = tags.find((tag) => tag.toLowerCase() === language);
  return base ? translations[base] ?? null : null;
}

/** An app's name, tagline and description (the Apps list, its page). */
export function localizedApp<T extends Pick<AppSummary, "name" | "description"> & { tagline?: string | null; translations?: Translations }>(app: T, locale: Locale): T {
  const text = translationFor(app.translations, locale);
  if (!text) return app;
  return {
    ...app,
    name: text.name ?? app.name,
    description: text.description ?? app.description,
    ...(app.tagline !== undefined ? { tagline: text.tagline ?? app.tagline } : {}),
  };
}

export type { Translation };

/** An app's name and its pages', cards', actions' and widgets' titles (navigation, detail pages, Home). */
export function localizedSurfaces(app: AppAdminSurfaces, locale: Locale): AppAdminSurfaces {
  const text = translationFor(app.translations, locale);
  if (!text) return app;
  return {
    ...app,
    name: text.name ?? app.name,
    pages: app.pages.map((page) => ({ ...page, title: text.pages?.[page.id] ?? page.title })),
    cards: app.cards.map((card) => ({ ...card, title: text.cards?.[card.id] ?? card.title })),
    actions: app.actions.map((action) => ({ ...action, label: text.actions?.[action.id] ?? action.label })),
    widgets: app.widgets.map((widget) => ({ ...widget, title: text.widgets?.[widget.id] ?? widget.title })),
    listColumns: app.listColumns.map((column) => ({ ...column, title: text.listColumns?.[column.id] ?? column.title })),
  };
}
