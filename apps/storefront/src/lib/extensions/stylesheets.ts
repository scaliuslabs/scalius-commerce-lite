// The stylesheets a page links in its head: those of the active apps the
// theme gives a skin, a section or a product block to (published, or the
// draft in a preview), of the apps whose components fill the slots every
// page has (the header's, the footer's), and of the app whose proxy page it is.
// The head is written before the body draws, so the theme names them, not
// the components drawn: a stylesheet is one immutable, cached file per app
// release, linked once and shared by every page.

import { parsePluginSurfaceKey } from "@scalius/shared/plugins/storefront";
import { STOREFRONT_PRODUCT_SLOTS } from "@scalius/shared/plugins/storefront-protocol";
import {
  STOREFRONT_STYLESHEET_FILE,
  storefrontExtensionBase,
  type StorefrontExtension,
} from "@scalius/shared/plugins/storefront-components";
import type { StorefrontThemeDocument } from "@scalius/shared/storefront-theme";

/** Every app the document names: its skins, the app sections and section skins of every page, and the product page's app blocks. */
export function themeAppIds(theme: StorefrontThemeDocument): Set<string> {
  const ids = new Set<string>();
  const add = (key: string | undefined) => {
    const parsed = key ? parsePluginSurfaceKey(key) : null;
    if (parsed) ids.add(parsed.pluginId);
  };
  for (const skin of Object.values(theme.apps?.skins ?? {})) add(skin?.app);
  for (const block of theme.blocks.product.apps ?? []) add(block.app);
  const sectionLists = [
    theme.pages.home,
    ...Object.values(theme.pages.landing).map((page) => page.sections),
    ...Object.values(theme.pages.templates).map((template) => template.sections),
  ];
  for (const sections of sectionLists) {
    for (const section of sections) {
      if (section.hidden) continue;
      if (section.type === "app") add(section.settings.app);
      else add(section.skin?.app);
    }
  }
  return ids;
}

const PRODUCT_SLOTS = new Set<string>(STOREFRONT_PRODUCT_SLOTS);
const PROXY_PAGE = /^\/apps\/([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*)(?:\/|$)/;

/** The apps a page may show: those the theme names, those filling a page-wide slot, and the app of a proxy page (`/apps/<id>/…`). */
export function pageAppIds(theme: StorefrontThemeDocument, extensions: readonly StorefrontExtension[], pathname: string): Set<string> {
  const ids = themeAppIds(theme);
  for (const extension of extensions) {
    if (extension.components.some((component) => component.targets.some((target) => target !== "page" && !PRODUCT_SLOTS.has(target)))) ids.add(extension.pluginId);
  }
  const page = PROXY_PAGE.exec(pathname)?.[1];
  if (page) ids.add(page);
  return ids;
}

/** The stylesheet URLs of the apps a page may show (`pageAppIds`), in app id order. */
export function themeAppStylesheets(theme: StorefrontThemeDocument, extensions: readonly StorefrontExtension[], pathname: string): string[] {
  const ids = pageAppIds(theme, extensions, pathname);
  return extensions
    .filter((extension) => extension.stylesheet && ids.has(extension.pluginId))
    .map((extension) => `${storefrontExtensionBase(extension.pluginId, extension.release)}${STOREFRONT_STYLESHEET_FILE}`);
}

/** The browser hosts the apps a page may show may reach (CSP `connect-src` and `img-src`). */
export function themeAppConnectHosts(theme: StorefrontThemeDocument, extensions: readonly StorefrontExtension[], pathname: string): string[] {
  const ids = pageAppIds(theme, extensions, pathname);
  return [...new Set(extensions.filter((extension) => ids.has(extension.pluginId)).flatMap((extension) => extension.connect))].sort();
}
