// An installed app's page in the dashboard's language: the manifest's
// `translations` for its name, description, surface titles, settings labels
// and section titles. Apart from app-text.ts, which the shell loads, so only
// the app page and a provider's setup sheet carry it.
import type { Locale } from "~/i18n";
import { providerLabel } from "~/i18n/provider-copy";
import type { AppDetail } from "~/lib/api-query-options/apps";
import type { AppAdminSurfaces } from "~/lib/api-query-options/apps";
import { localizedApp, translationFor, type Translation } from "./app-text";

type Page = AppDetail["admin"]["pages"][number];

/** A page's title and its tabs' titles. */
function localizedPage<T extends Pick<Page, "id" | "title" | "tabs">>(page: T, text: Translation): T {
  const tabs = text.tabs?.[page.id];
  return {
    ...page,
    title: text.pages?.[page.id] ?? page.title,
    tabs: page.tabs ? page.tabs.map((tab) => ({ ...tab, title: tabs?.[tab.id] ?? tab.title })) : page.tabs,
  };
}

/** One app page as an app page route draws it: its title and its tabs' titles. */
export function localizedAppPage(app: Pick<AppAdminSurfaces, "translations">, page: AppAdminSurfaces["pages"][number], locale: Locale) {
  const text = translationFor(app.translations, locale);
  return text ? localizedPage(page, text) : page;
}

/**
 * An app's page: its name and description, the titles of its pages, cards,
 * actions and widgets, and its settings' labels, help and section titles.
 */
export function localizedAppDetail(app: AppDetail, locale: Locale): AppDetail {
  app = { ...app, providers: app.providers.map((provider) => ({ ...provider, name: providerLabel(provider.name, locale) })) };
  const text = translationFor(app.translations, locale);
  if (!text) return app;
  const group = (id: string) => text.settingsGroups?.[id];
  return {
    ...localizedApp(app, locale),
    admin: {
      ...app.admin,
      pages: app.admin.pages.map((page) => localizedPage(page, text)),
      cards: app.admin.cards.map((card) => ({ ...card, title: text.cards?.[card.id] ?? card.title })),
      actions: app.admin.actions.map((action) => ({ ...action, label: text.actions?.[action.id] ?? action.label })),
      widgets: app.admin.widgets.map((widget) => ({ ...widget, title: text.widgets?.[widget.id] ?? widget.title })),
    },
    settings: {
      ...app.settings,
      fields: app.settings.fields.map((field) => {
        const own = text.settings?.[field.key];
        return own ? { ...field, label: own.label ?? field.label, help: own.help ?? field.help } : field;
      }),
      sections: app.settings.sections.map((section) => (section.group
        ? {
          ...section,
          group: {
            ...section.group,
            title: group(section.group.id)?.title ?? section.group.title,
            description: group(section.group.id)?.description ?? section.group.description,
          },
        }
        : section)),
    },
  };
}
