// The stylesheets a page links in its head: those of the active apps the
// theme gives a slot or a section to (published, or the draft in a preview).
// The head is written before the body draws, so the theme names them, not
// the components drawn: a stylesheet is one immutable, cached file per app
// release, linked once and shared by every page.

import { parsePluginSurfaceKey } from "@scalius/shared/plugins/storefront";
import {
  STOREFRONT_STYLESHEET_FILE,
  storefrontExtensionBase,
  type StorefrontExtension,
} from "@scalius/shared/plugins/storefront-components";
import type { StorefrontThemeDocument } from "@scalius/shared/storefront-theme";

/** Every app the document names: its slots and the app sections of every page. */
export function themeAppIds(theme: StorefrontThemeDocument): Set<string> {
  const ids = new Set<string>();
  const add = (key: string | undefined) => {
    const parsed = key ? parsePluginSurfaceKey(key) : null;
    if (parsed) ids.add(parsed.pluginId);
  };
  add(theme.apps?.header?.app);
  add(theme.apps?.footer?.app);
  add(theme.apps?.productCard?.app);
  const sectionLists = [
    theme.pages.home,
    ...Object.values(theme.pages.landing).map((page) => page.sections),
    ...Object.values(theme.pages.templates).map((template) => template.sections),
  ];
  for (const sections of sectionLists) {
    for (const section of sections) if (section.type === "app" && !section.hidden) add(section.settings.app);
  }
  return ids;
}

/** The stylesheet URLs of the apps the theme names, in app id order. */
export function themeAppStylesheets(theme: StorefrontThemeDocument, extensions: readonly StorefrontExtension[]): string[] {
  const ids = themeAppIds(theme);
  return extensions
    .filter((extension) => extension.stylesheet && ids.has(extension.pluginId))
    .map((extension) => `${storefrontExtensionBase(extension.pluginId, extension.release)}${STOREFRONT_STYLESHEET_FILE}`);
}

/** The browser hosts the apps the theme names may reach (CSP `connect-src` and `img-src`). */
export function themeAppConnectHosts(theme: StorefrontThemeDocument, extensions: readonly StorefrontExtension[]): string[] {
  const ids = themeAppIds(theme);
  return [...new Set(extensions.filter((extension) => ids.has(extension.pluginId)).flatMap((extension) => extension.connect))].sort();
}
