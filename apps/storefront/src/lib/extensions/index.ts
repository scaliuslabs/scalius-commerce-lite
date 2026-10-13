// App storefront components in a page (docs/STOREFRONT-COMPONENTS.md): which
// active apps ship components (the layout read's `appExtensions`), which
// slots the theme gives to an app, and the request's render host. Everything
// here is read from what the page already read: no extra API call.

import { env as workerEnv } from "cloudflare:workers";
import { STOREFRONT_APP_SLOT_KEYS } from "@scalius/shared/storefront-theme";
import { parsePluginSurfaceKey } from "@scalius/shared/plugins/storefront";
import type { PluginSettingsSchema } from "@scalius/shared/plugins/settings-schema";
import {
  readStorefrontExtensions,
  resolveStorefrontSettings,
  type StorefrontComponentSlot,
  type StorefrontExtension,
  type StorefrontRenderContext,
  type StorefrontResolvedSettings,
} from "@scalius/shared/plugins/storefront-components";
import { getLayoutData } from "@/lib/api/storefront";
import { getRuntime } from "@/lib/api/runtime";
import { appComponentsRenderOn, storefrontAppPage } from "@/lib/app-scripts";
import { storeRegion, storeTimeZone } from "@/lib/store-time-zone";
import { dateLocale } from "@scalius/shared/locale-format";
import { markPageUnproven } from "@/lib/page-dependencies";
import { currentRequestTheme } from "@/lib/storefront-theme-context";
import { ExtensionHost } from "./host";
import type { ExtensionRuntime } from "./loaders";

export { ExtensionHost } from "./host";

interface RequestExtensions {
  list: StorefrontExtension[];
  byId: Map<string, StorefrontExtension>;
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
  return (workerEnv ?? {}) as unknown as ExtensionRuntime["env"];
}

function pageKind(path: string): StorefrontRenderContext["page"]["kind"] {
  if (path === "/") return "home";
  if (path.startsWith("/pages/")) return "landing";
  if (path.startsWith("/products/")) return "product";
  if (/^\/(?:categories|collections|brands)(?:\/|$)/.test(path)) return "listing";
  if (path.startsWith("/search")) return "search";
  if (path === "/cart" || path.startsWith("/checkout")) return "cart";
  return "other";
}

/** The request's extensions and render host (one per request, built on first use). */
export function requestExtensions(locals: object, url: URL): Promise<RequestExtensions> {
  let pending = perRequest.get(locals);
  if (!pending) {
    pending = (async () => {
      const [layout, theme] = await Promise.all([getLayoutData(), currentRequestTheme(locals)]);
      // App components cannot name a page, so none renders on a buyer's page (lib/app-scripts.ts).
      // The page drawn: the request's, or the one the library previews.
      const path = previewPages.get(locals) ?? url.pathname;
      // The store's own values, never a guess: without its currency no component draws.
      const currency = layout?.currency?.code ?? "";
      const list = currency && appComponentsRenderOn(storefrontAppPage(path)) ? readStorefrontExtensions(layout?.appExtensions) : [];
      const page = pages.get(locals);
      const language = page?.language ?? theme.language;
      const byId = new Map(list.map((extension) => [extension.pluginId, extension]));
      const context: StorefrontRenderContext = {
        store: {
          name: page?.storeName ?? "",
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
        runtime: { env: runtimeEnv() },
        context,
        jsonLd: () => pages.get(locals)?.noIndex !== true,
        // A page drawn with a fallback is never stored (it would stay until an unrelated write).
        degraded: () => markPageUnproven(dependencies),
      });
      return { list, byId, host };
    })();
    perRequest.set(locals, pending);
  }
  return pending;
}

export interface AppSlot {
  extension: StorefrontExtension;
  /** The manifest slot id. */
  component: string;
  settings: StorefrontResolvedSettings;
}

/**
 * The app filling a slot in the request's theme (published, or the draft in
 * a preview), with its settings resolved; null when the theme keeps the core
 * block or the app is no longer active, approved or declaring that slot.
 */
export async function appSlot(locals: object, url: URL, slot: StorefrontComponentSlot): Promise<AppSlot | null> {
  const theme = await currentRequestTheme(locals);
  const ref = theme.theme.apps?.[STOREFRONT_APP_SLOT_KEYS[slot]];
  if (!ref) return null;
  const key = parsePluginSurfaceKey(ref.app);
  if (!key) return null;
  const { byId } = await requestExtensions(locals, url);
  const extension = byId.get(key.pluginId);
  const declaration = extension?.slots.find((entry) => entry.id === key.type && entry.slot === slot);
  if (!extension || !declaration) return null;
  return { extension, component: declaration.id, settings: resolveSlotSettings(declaration.settings, ref.values) };
}

/** A slot's settings: no images or products (the manifest forbids them), so nothing to read. */
export function resolveSlotSettings(schema: PluginSettingsSchema, values: unknown): StorefrontResolvedSettings {
  return resolveStorefrontSettings(schema, values, { image: () => null, products: () => [] });
}
