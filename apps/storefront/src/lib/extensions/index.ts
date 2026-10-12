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
import { currentRequestTheme } from "@/lib/storefront-theme-context";
import { ExtensionHost } from "./host";
import type { ExtensionRuntime } from "./loaders";

export { ExtensionHost } from "./host";

interface RequestExtensions {
  list: StorefrontExtension[];
  byId: Map<string, StorefrontExtension>;
  host: ExtensionHost;
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
      const list = readStorefrontExtensions(layout?.appExtensions);
      const byId = new Map(list.map((extension) => [extension.pluginId, extension]));
      const context: StorefrontRenderContext = {
        store: {
          name: layout?.business?.companyName?.trim() || "Store",
          currency: layout?.currency?.code ?? "BDT",
          locale: theme.language === "bn" ? "bn-BD" : "en-BD",
          language: theme.language,
          timeZone: layout?.timeZone?.trim() || "Asia/Dhaka",
        },
        page: { kind: pageKind(url.pathname), path: url.pathname },
        assets: "",
        preview: theme.preview !== null,
      };
      return { list, byId, host: new ExtensionHost({ runtime: { env: runtimeEnv() }, context }) };
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
