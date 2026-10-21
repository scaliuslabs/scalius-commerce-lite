// App storefront components in a page (packages/plugin-sdk/docs/storefront.md): which
// active apps ship components (the layout read's `appExtensions`), which
// units the theme gives to an app's skin, which components fill a slot,
// and the request's render host. Everything here is read from what
// the page already read: no extra API call.

import type { StorefrontSkinRef, StorefrontThemeSkinUnit } from "@scalius/shared/storefront-theme";
import { resolvePluginSettingBindings } from "@scalius/shared/storefront-theme/bindings";
import { parsePluginSurfaceKey } from "@scalius/shared/plugins/storefront";
import type { PluginSettingsSchema } from "@scalius/shared/plugins/settings-schema";
import {
  readStorefrontExtensions,
  resolveStorefrontSettings,
  STOREFRONT_PRODUCT_SLOTS,
  storefrontComponentProductSlot,
  storefrontEmbedRule,
  storefrontExtensionBase,
  type StorefrontComponentSlot,
  type StorefrontEmbedKind,
  type StorefrontExtension,
  type StorefrontImage,
  type StorefrontRenderContext,
  type StorefrontResolvedSettings,
  type StorefrontSkinJob,
  type StorefrontSkinTarget,
} from "@scalius/shared/plugins/storefront-components";
import { splitStorefrontEmbeds, type StorefrontMarkupPart } from "@scalius/shared/plugins/storefront-embeds";
import { getLayoutData } from "@/lib/api/storefront";
import { getRuntime, getRuntimePresence, getWorkerEnv } from "@/lib/api/runtime";
import { presencePageLanguage } from "@/lib/market-selector";
import { resolveStoreDisplayName } from "@/lib/store-identity";
import { getAbsoluteStorefrontSeoBaseUrl } from "@/lib/seo-base-url";
import { appComponentsRenderOn, storefrontAppPage } from "@/lib/app-scripts";
import { pageKind } from "./page-kind";
import { storeRegion, storeTimeZone } from "@/lib/store-time-zone";
import { dateLocale } from "@scalius/shared/locale-format";
import { markPageUnproven } from "@/lib/page-dependencies";
import { currentRequestTheme } from "@/lib/storefront-theme-context";
import { ExtensionHost } from "./host";
import { storefrontImageOf } from "./data";
import type { ExtensionRuntime } from "./loaders";

export { ExtensionHost } from "./host";

interface RequestExtensions {
  list: readonly StorefrontExtension[];
  byId: Map<string, StorefrontExtension>;
  /** The component slots some active app's component targets (a unit leaves the others out). */
  filled: ReadonlySet<string>;
  host: ExtensionHost;
}

// Only the authenticated library route supplies a validated intended page.
// It is context for a renderer, never a destination for an API request.
const previewPages = new WeakMap<object, string>();
export function setExtensionPreviewPage(locals: object, path: string): void {
  previewPages.set(locals, path);
}

/** What Layout knows of the page before its body draws (and app components with it). */
export interface ExtensionPage {
  /** The page's language (`<html lang>`). */
  language: string;
  /** The store's display name. */
  storeName: string;
  /** A `noindex` page: app JSON-LD stays out of it. */
  noIndex: boolean;
}
const pages = new WeakMap<object, ExtensionPage>();
export function setExtensionPage(locals: object, page: ExtensionPage): void {
  pages.set(locals, page);
}

const perRequest = new WeakMap<object, Promise<RequestExtensions>>();

function runtimeEnv(): ExtensionRuntime["env"] {
  return (getWorkerEnv() ?? {}) as unknown as ExtensionRuntime["env"];
}

/** The request's extensions and render host (one per request, built on first use). */
export function requestExtensions(locals: object, url: URL): Promise<RequestExtensions> {
  let pending = perRequest.get(locals);
  if (!pending) {
    pending = (async () => {
      // Outside a request (a unit rendered alone) there is no store, so no app draws.
      const [layout, theme] = await Promise.all([getRuntime() ? getLayoutData() : null, currentRequestTheme(locals)]);
      // App components cannot name a page, so none renders on a buyer's page (lib/app-scripts.ts).
      // The page drawn: the request's, or the one the library previews.
      const path = previewPages.get(locals) ?? url.pathname;
      // The store's own values, never a guess: without its currency no component draws.
      const currency = layout?.currency?.code ?? "";
      const list = currency && appComponentsRenderOn(storefrontAppPage(path)) ? readStorefrontExtensions(layout?.appExtensions) : [];
      // Layout states the page before its body draws; a page that draws a skin
      // before its Layout (the product page's main part) gets the same values
      // by Layout's own rules (the default document language of public pages).
      const page = pages.get(locals) ?? {
        language: presencePageLanguage(layout?.markets, getRuntimePresence(), "en"),
        storeName: resolveStoreDisplayName(layout?.business, getAbsoluteStorefrontSeoBaseUrl()) ?? "",
        noIndex: false,
      };
      const language = page.language;
      const byId = new Map(list.map((extension) => [extension.pluginId, extension]));
      const context: StorefrontRenderContext = {
        store: {
          name: page.storeName,
          currency,
          locale: dateLocale(language, storeRegion()),
          language,
          timeZone: storeTimeZone(),
        },
        page: { kind: pageKind(path), path },
        assets: "",
        preview: theme.preview !== null,
      };
      const dependencies = getRuntime()?.pageDependencies;
      const host = new ExtensionHost({
        runtime: { env: runtimeEnv(), store: getRuntime()?.STOREFRONT_URL },
        context,
        jsonLd: () => pages.get(locals)?.noIndex !== true,
        // A page drawn with a fallback is never stored (it would stay until an unrelated write).
        degraded: () => markPageUnproven(dependencies),
      });
      const filled = new Set(list.flatMap((extension) => extension.components.flatMap((component) => component.targets)));
      return { list, byId, filled, host };
    })();
    perRequest.set(locals, pending);
  }
  return pending;
}

export interface AppSkin {
  extension: StorefrontExtension;
  target: StorefrontSkinTarget;
  /** The manifest skin id. */
  component: string;
  settings: StorefrontResolvedSettings;
}

/**
 * The app skin drawing a unit in the request's theme (published, or the
 * draft in a preview), with its settings resolved: the theme's
 * `apps.skins.<unit>`, or `ref` (a core section's own `skin`). Null when
 * core draws the unit: no skin, or its app is no longer active, approved or
 * declaring that skin for this target.
 */
export async function appSkin(locals: object, url: URL, target: StorefrontSkinTarget, ref?: StorefrontSkinRef | null): Promise<AppSkin | null> {
  let chosen = ref;
  if (chosen === undefined) {
    const theme = await currentRequestTheme(locals);
    chosen = theme.theme.apps?.skins?.[target as StorefrontThemeSkinUnit];
  }
  if (!chosen) return null;
  const key = parsePluginSurfaceKey(chosen.app);
  if (!key) return null;
  const { byId } = await requestExtensions(locals, url);
  const extension = byId.get(key.pluginId);
  const declaration = extension?.skins.find((entry) => entry.id === key.type && entry.target === target);
  if (!extension || !declaration) return null;
  const { bindingContext, skinMedia } = await currentRequestTheme(locals);
  const values = resolvePluginSettingBindings(declaration.settings, chosen.values, chosen.bindings, bindingContext);
  // A unit skin's images came with the layout read (`skinMedia`); a section skin names none.
  const image = ref === undefined ? (id: string) => storefrontImageOf(skinMedia.get(id)) : undefined;
  return { extension, target, component: declaration.id, settings: resolveSkinSettings(declaration.settings, values, image) };
}

/** A skin's or component's settings: no products (the manifest forbids them); a unit skin's images from the layout read. */
export function resolveSkinSettings(schema: PluginSettingsSchema, values: unknown, image: (mediaId: string) => StorefrontImage | null = () => null): StorefrontResolvedSettings {
  return resolveStorefrontSettings(schema, values, { image, products: () => [] });
}

/** A component's checked markup, cut at its embeds, ready for AppComponent. */
export interface AppMarkup {
  pluginId: string;
  /** `/_x/<plugin id>/<release>/`. */
  base: string;
  parts: StorefrontMarkupPart[];
  /** The embed kinds it places (the page leaves its own copy of those out). */
  embeds: ReadonlySet<StorefrontEmbedKind>;
}

const contractWarnings = new Set<string>();

/** Cuts checked markup under its unit's embed rule; null when it draws nothing or misses a required embed. */
export function appMarkup(extension: StorefrontExtension, unit: Parameters<typeof storefrontEmbedRule>[0], html: string | null): AppMarkup | null {
  if (html === null || html.trim() === "") return null;
  const split = splitStorefrontEmbeds(html, storefrontEmbedRule(unit));
  if (split.missing.length > 0) {
    const key = `${extension.pluginId}:${unit}`;
    if (!contractWarnings.has(key) && contractWarnings.size < 200) {
      contractWarnings.add(key);
      console.warn(`[Storefront components] ${extension.pluginId} ${unit} skin places no ${split.missing.join(", ")}: the store draws its own.`);
    }
    return null;
  }
  return {
    pluginId: extension.pluginId,
    base: storefrontExtensionBase(extension.pluginId, extension.release),
    parts: split.parts,
    embeds: new Set(split.parts.flatMap((part) => (part.kind === "embed" ? [part.embed] : []))),
  };
}

type SkinAsk<Target extends StorefrontSkinTarget> = Extract<StorefrontSkinJob, { target: Target }> extends infer Job
  ? Job extends unknown ? Omit<Job, "id" | "kind" | "component" | "settings" | "target"> : never
  : never;

/**
 * Draws a skin with its unit's projection: its markup cut at its embeds,
 * or null when core draws the unit (the skin drew nothing, failed, was
 * late, or misses a required embed). App JSON-LD stays out of product and
 * listing pages: their structured data is core's alone.
 */
export async function renderAppSkin<Target extends StorefrontSkinTarget>(
  locals: object,
  url: URL,
  skin: AppSkin & { target: Target },
  ask: SkinAsk<Target>,
): Promise<AppMarkup | null> {
  const { host } = await requestExtensions(locals, url);
  const jsonLd = skin.target !== "product_main" && skin.target !== "listing_main";
  const html = await host.render(skin.extension, {
    kind: "skin", target: skin.target, component: skin.component, settings: skin.settings, ...ask,
  } as never, { jsonLd });
  return appMarkup(skin.extension, skin.target, html);
}

/** A component that fills a slot, with its settings resolved. */
export interface AppSlotComponent {
  extension: StorefrontExtension;
  /** The manifest component type. */
  type: string;
  /** The theme's id of the placement (product slots). */
  instanceId?: string;
  settings: StorefrontResolvedSettings;
}

const PRODUCT_SLOTS = new Set<string>(STOREFRONT_PRODUCT_SLOTS);

/**
 * The components a slot shows. A product slot: the theme's product app
 * blocks (`blocks.product.apps`) whose component's product slot it is, in the
 * merchant's order, with their values. Any other slot: every active app's
 * component that targets it, in app id order, with its default values. An
 * app that is gone, inactive or no longer declares the component shows nothing.
 */
export async function appSlotComponents(locals: object, url: URL, slot: StorefrontComponentSlot): Promise<AppSlotComponent[]> {
  const { list, byId } = await requestExtensions(locals, url);
  if (!PRODUCT_SLOTS.has(slot)) {
    return list.flatMap((extension) => extension.components
      .filter((component) => component.targets.includes(slot))
      .map((component) => ({ extension, type: component.type, settings: resolveSkinSettings(component.settings, {}) })));
  }
  const theme = await currentRequestTheme(locals);
  const placed = theme.theme.blocks.product.apps ?? [];
  return placed.flatMap((block) => {
    const key = parsePluginSurfaceKey(block.app);
    const extension = key ? byId.get(key.pluginId) : undefined;
    const declaration = extension?.components.find((entry) => entry.type === key!.type);
    if (!extension || !declaration || storefrontComponentProductSlot(declaration.targets) !== slot) return [];
    return [{ extension, instanceId: block.id, type: declaration.type, settings: resolveSkinSettings(declaration.settings, resolvePluginSettingBindings(declaration.settings, block.values, block.bindings, theme.bindingContext)) }];
  });
}
