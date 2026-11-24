// The files a theme document names from an app's `public/` folder (a private
// page's icons, a bottom bar link tab's icon): one check that every one is
// the theme's own app's, the app its look came from (`apps.template`). A
// save refuses another vendor's file with `foreign_asset`; an app template
// names one app's files only.
import { parsePluginSurfaceKey } from "../plugins/storefront";

export const STOREFRONT_FOREIGN_ASSET = "foreign_asset" as const;

export interface StorefrontThemeAssetRef {
  app: string;
  file: string;
}

export interface StorefrontThemeAssetIssue {
  path: Array<string | number>;
  reason: typeof STOREFRONT_FOREIGN_ASSET;
  message: string;
}

/** The parts of a document (or an app template) that name app files. */
export interface StorefrontThemeAssetHolder {
  blocks?: { mobileNav?: { variant: string; settings?: unknown } } | undefined;
  privatePages?: { icons?: Partial<Record<string, StorefrontThemeAssetRef>> } | undefined;
  apps?: { template?: string } | undefined;
}

/** Every app file the document names, with its path. */
export function storefrontThemeAssetRefs(theme: StorefrontThemeAssetHolder): Array<[Array<string | number>, StorefrontThemeAssetRef]> {
  const refs: Array<[Array<string | number>, StorefrontThemeAssetRef]> = [];
  for (const [key, ref] of Object.entries(theme.privatePages?.icons ?? {})) {
    if (ref) refs.push([["privatePages", "icons", key], ref]);
  }
  const nav = theme.blocks?.mobileNav;
  const tabs = nav?.variant === "bottom-tabs" ? (nav.settings as { tabs?: unknown } | undefined)?.tabs : undefined;
  if (Array.isArray(tabs)) {
    tabs.forEach((tab: { kind?: unknown; icon?: { source?: unknown; app?: unknown; file?: unknown } }, index) => {
      const icon = tab?.icon;
      if (tab?.kind === "link" && icon?.source === "app" && typeof icon.app === "string" && typeof icon.file === "string") {
        refs.push([["blocks", "mobileNav", "settings", "tabs", index, "icon"], { app: icon.app, file: icon.file }]);
      }
    });
  }
  return refs;
}

/** The theme's own app: the app its look came from (null: the theme names no files). */
export function storefrontThemeApp(theme: Pick<StorefrontThemeAssetHolder, "apps">): string | null {
  return theme.apps?.template ? parsePluginSurfaceKey(theme.apps.template)?.pluginId ?? null : null;
}

/** Each file that is not the theme's own app's, refused with `foreign_asset`. */
export function storefrontThemeAssetIssues(theme: StorefrontThemeAssetHolder, themeApp: string | null = storefrontThemeApp(theme)): StorefrontThemeAssetIssue[] {
  return storefrontThemeAssetRefs(theme).flatMap(([path, ref]) => ref.app === themeApp ? [] : [{
    path,
    reason: STOREFRONT_FOREIGN_ASSET,
    message: `${ref.app}/${ref.file}: a theme names only its own app's files${themeApp ? ` (${themeApp})` : ""}.`,
  }]);
}

/** The one app an app template's files come from (null when it names none or several: then every file is refused). */
export function storefrontTemplateAssetApp(theme: StorefrontThemeAssetHolder): string | null {
  const apps = new Set(storefrontThemeAssetRefs(theme).map(([, ref]) => ref.app));
  return apps.size === 1 ? [...apps][0]! : null;
}
