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
  STOREFRONT_STYLESHEET_FILE,
  type StorefrontComponentSlot,
  type StorefrontEmbedKind,
  type StorefrontExtension,
  type StorefrontImage,
  type StorefrontRenderContext,
  type StorefrontResolvedSettings,
  type StorefrontSkinJob,
  type StorefrontSkinTarget,
  type StorefrontRenderJob,
} from "@scalius/shared/plugins/storefront-components";
import { splitStorefrontEmbeds, type StorefrontMarkupPart } from "@scalius/shared/plugins/storefront-embeds";
import { getLayoutData } from "@/lib/api/storefront";
import { getRuntime, getRuntimePresence, getRuntimePrivateImageOrigins, getRuntimeStorefrontUrl, getWorkerEnv } from "@/lib/api/runtime";
import { INERT_MARKUP_MAX_BYTES, inertChromeHtml } from "@scalius/shared/plugins/inert-html";
import { checkedBuyerChromeSheet } from "@scalius/shared/plugins/buyer-chrome-css";
import { cspSourcesAllowImage } from "@scalius/shared/security-csp";
import { buyerChromeRoot } from "@/lib/cache-policy";
import { layoutPageLanguage } from "@/lib/market-selector";
import { resolveStoreDisplayName } from "@/lib/store-identity";
import { getAbsoluteStorefrontSeoBaseUrl } from "@/lib/seo-base-url";
import { appComponentsRenderOn, storefrontAppPage } from "@/lib/app-scripts";
import { pageKind } from "./page-kind";
import { storeRegion, storeTimeZone } from "@/lib/store-time-zone";
import { dateLocale } from "@scalius/shared/locale-format";
import { markRenderDegraded } from "@/lib/page-dependencies";
import { currentRequestTheme } from "@/lib/storefront-theme-context";
import { ExtensionHost, warnOnce } from "./host";
import { readExtensionFile } from "./files";
import { storefrontIncidentReporter } from "./incidents";
import { storeLogo, storefrontImageOf } from "./data";
import type { ExtensionRuntime } from "./loaders";
import { bindPurchaseControls, type PurchasePage } from "./purchase-controls";
import type { StorefrontProductPage } from "@scalius/shared/plugins/storefront-protocol";

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

/** The request's `waitUntil` (Astro on Workers), when it has one. */
function requestWaitUntil(locals: object): ((promise: Promise<unknown>) => void) | undefined {
  const context = (locals as { cfContext?: ExecutionContext }).cfContext;
  return context ? (promise) => context.waitUntil(promise) : undefined;
}

/** The request's extensions and render host (one per request, built on first use). */
export function requestExtensions(locals: object, url: URL): Promise<RequestExtensions> {
  let pending = perRequest.get(locals);
  if (!pending) {
    // App components cannot name a page, so none renders on a buyer's page (lib/app-scripts.ts).
    // The page drawn: the request's, or the one the library previews.
    const path = previewPages.get(locals) ?? url.pathname;
    pending = buildExtensions(locals, path, (layout) => appComponentsRenderOn(storefrontAppPage(path)) ? readStorefrontExtensions(layout?.appExtensions) : []);
    perRequest.set(locals, pending);
  }
  return pending;
}

const perBuyerChrome = new WeakMap<object, Promise<RequestExtensions>>();

/**
 * The render host for a buyer page's chrome (`buyerPageChrome`): only the
 * apps with a header or footer skin that draws on buyer pages, told the page
 * is the buyer page's root (`/account`: never an order's or a claim's path)
 * of kind `buyer`, with no JSON-LD.
 */
function buyerChromeExtensions(locals: object, root: string): Promise<RequestExtensions> {
  let pending = perBuyerChrome.get(locals);
  if (!pending) {
    pending = buildExtensions(locals, root, (layout) => readStorefrontExtensions(layout?.appExtensions)
      .filter((extension) => extension.skins.some((skin) => skin.buyerPages === true)), false);
    perBuyerChrome.set(locals, pending);
  }
  return pending;
}

function buildExtensions(
  locals: object,
  path: string,
  extensions: (layout: Awaited<ReturnType<typeof getLayoutData>>) => readonly StorefrontExtension[],
  jsonLd = true,
): Promise<RequestExtensions> {
  return (async () => {
    // Outside a request (a unit rendered alone) there is no store, so no app draws.
    const [layout, theme] = await Promise.all([getRuntime() ? getLayoutData() : null, currentRequestTheme(locals)]);
    // The store's own values, never a guess: without its currency no component draws.
    const currency = layout?.currency?.code ?? "";
    const list = currency ? extensions(layout) : [];
    // Layout states the page before its body draws; a page that draws a skin
    // before its Layout (the product page's main part) gets the same values
    // by Layout's own rules (the default document language of public pages).
    const page = pages.get(locals) ?? {
      language: layoutPageLanguage(layout, getRuntimePresence()),
      storeName: resolveStoreDisplayName(layout?.business, getAbsoluteStorefrontSeoBaseUrl()) ?? "",
      noIndex: false,
    };
    const language = page.language;
    const byId = new Map(list.map((extension) => [extension.pluginId, extension]));
    const context: StorefrontRenderContext = {
      store: {
        name: page.storeName,
        currency,
        // The store's own (an app's settings amounts are in it): the shop currency a market's page names.
        storeCurrency: layout?.currency?.shopCode || currency,
        locale: dateLocale(language, storeRegion()),
        language,
        timeZone: storeTimeZone(),
        logo: storeLogo(theme, page.storeName || null),
        darkLogo: storeLogo(theme, page.storeName || null, "darkLogo"),
      },
      page: { kind: pageKind(path), path },
      assets: "",
      preview: theme.preview !== null,
    };
    const dependencies = getRuntime()?.pageDependencies;
    const host = new ExtensionHost({
      runtime: { env: runtimeEnv(), store: getRuntime()?.STOREFRONT_URL },
      context,
      jsonLd: () => jsonLd && pages.get(locals)?.noIndex !== true,
      // A page drawn with a fallback is never stored (it would stay until an unrelated write)
      // nor handed to a request that joined its render.
      degraded: () => markRenderDegraded(dependencies),
      // ...and the app's log says which part and why (the merchant and the theme editor read it).
      report: storefrontIncidentReporter(runtimeEnv() as Parameters<typeof storefrontIncidentReporter>[0], requestWaitUntil(locals)),
    });
    const filled = new Set(list.flatMap((extension) => extension.components.flatMap((component) => component.targets)));
    return { list, byId, filled, host };
  })();
}

/** A theme's header or footer on a buyer page: its inert markup and the checked text of its stylesheet (null: it ships none). */
export interface BuyerChrome {
  html: string;
  sheet: string | null;
}

/** What a page's buyer chrome asks for: the projection each region's skin is drawn from. */
export interface BuyerChromeAsk {
  header: (() => unknown) | null;
  footer: (() => unknown) | null;
}

/**
 * The theme's header and footer on one of the buyer's own pages
 * (`buyerChromeRoot`), where the skin the theme names declares `buyerPages`
 * and a Super Admin approved it: each drawn from the same projection as on a
 * public page, told the page is `buyer` at its root, then rebuilt inert
 * (`inertHtml`); its slots draw nothing (the store's controls stay outside
 * the shadow root). Decided once for the page: when a region that asks cannot
 * draw (an inactive app, a skin that draws nothing or misses its embeds,
 * markup over the rebuild's bound, a stylesheet that cannot be read or does
 * not pass `checkedBuyerChromeSheet`), neither does the other, so the page
 * shows the store's own header and footer, never one of each. The caller
 * decides the page may show it at all (never where the buyer pays).
 */
export async function buyerPageChrome(locals: object, url: URL, ask: BuyerChromeAsk): Promise<{ header: BuyerChrome | null; footer: BuyerChrome | null }> {
  const none = { header: null, footer: null };
  const root = buyerChromeRoot(url.pathname);
  if (!root) return none;
  const theme = await currentRequestTheme(locals);
  const { byId, host } = await buyerChromeExtensions(locals, root);
  const sheets = new Map<string, Promise<string | false | null>>();
  const region = async (target: "header" | "footer", data: () => unknown): Promise<BuyerChrome | null | "store"> => {
    const ref = theme.theme.apps?.skins?.[target];
    const key = ref ? parsePluginSurfaceKey(ref.app) : null;
    const extension = key ? byId.get(key.pluginId) : undefined;
    const declaration = extension?.skins.find((entry) => entry.id === key!.type && entry.target === target && entry.buyerPages === true);
    // No skin asks to draw here: the store's own region, which says nothing about the other one.
    if (!ref || !extension || !declaration) return "store";
    // One read of an app's sheet per page, shared by its header and footer.
    if (!sheets.has(extension.pluginId)) sheets.set(extension.pluginId, extension.stylesheet ? buyerChromeSheet(extension, url.origin) : Promise.resolve(null));
    const sheet = await sheets.get(extension.pluginId)!;
    if (sheet === false) return null;
    const values = resolvePluginSettingBindings(declaration.settings, ref.values, ref.bindings, theme.bindingContext);
    const settings = resolveSkinSettings(declaration.settings, values, (id) => storefrontImageOf(theme.skinMedia.get(id)));
    const projection = await data();
    const rendered = await host.render(extension, { kind: "skin", target, component: declaration.id, settings, data: projection } as never, { jsonLd: false });
    const markup = appMarkup(extension, target, rendered);
    if (!markup) return null;
    // Its embeds (its slots) draw nothing here: the markup around them is rebuilt as one document, so an element
    // that opens before a slot and closes after it stays one element, and a button still finds its drawer.
    const html = inertHtml(markup.parts.map((part) => (part.kind === "html" ? part.html : "")).join(""), handedLinks(projection));
    if (html === null) {
      warnOnce(`buyer-chrome-size:${extension.pluginId}:${target}`, `${extension.pluginId} ${target} skin draws over ${INERT_MARKUP_MAX_BYTES / 1024} KiB on a buyer page: the store draws its own header and footer there.`);
      return null;
    }
    return html.trim() === "" ? null : { html, sheet };
  };
  const [header, footer] = await Promise.all([
    ask.header ? region("header", ask.header) : "store" as const,
    ask.footer ? region("footer", ask.footer) : "store" as const,
  ]);
  if (header === null || footer === null) return none;
  return { header: header === "store" ? null : header, footer: footer === "store" ? null : footer };
}

/**
 * The URLs a skin may link off the store on a buyer page: those of the store's
 * own projection that the merchant set in the store, never the theme (the
 * header's menu and category menu, the footer's menus, social profiles and
 * policies), and the store's routes. Never a value of the skin's settings or
 * of the theme document: a template ships those, so they would be the theme's
 * own URLs dressed as the merchant's.
 */
export function handedLinks(projection: unknown): Set<string> {
  const out = new Set<string>();
  const data = (projection ?? {}) as {
    routes?: Record<string, unknown>;
    menu?: unknown; categories?: unknown; menus?: unknown; policies?: unknown;
    store?: { social?: unknown };
  };
  const menu = (items: unknown, depth = 0) => {
    if (!Array.isArray(items) || depth > 4) return;
    for (const item of items) {
      const entry = item as { url?: unknown; children?: unknown; items?: unknown };
      if (typeof entry?.url === "string") out.add(entry.url);
      menu(entry?.children, depth + 1);
      menu(entry?.items, depth + 1);
    }
  };
  for (const route of Object.values(data.routes ?? {})) if (typeof route === "string") out.add(route);
  menu(data.menu);
  menu(data.categories);
  menu(data.menus);
  menu(data.policies);
  menu(data.store?.social);
  return out;
}

/** Checked sheet texts this isolate keeps, by store and app release (a release's files never change). */
const checkedSheets = new Map<string, string | false>();
const CHECKED_SHEETS_MAX = 8;

/**
 * The app's stylesheet as a buyer page's shadow root may hold it: its bytes
 * read once per isolate and release, checked and rebased
 * (`checkedBuyerChromeSheet`), the text the store writes. False when it does
 * not pass (kept) or cannot be read now (not kept: the next page reads it again).
 */
async function buyerChromeSheet(extension: StorefrontExtension, store: string): Promise<string | false> {
  const key = `${store} ${extension.pluginId}/${extension.release}`;
  const known = checkedSheets.get(key);
  if (known !== undefined) return known;
  const file = await readExtensionFile((getWorkerEnv() ?? {}) as { BACKEND_API?: Fetcher }, store, extension.pluginId, extension.release, STOREFRONT_STYLESHEET_FILE).catch(() => null);
  if (!file) return false;
  const checked = checkedBuyerChromeSheet(file.bytes, storefrontExtensionBase(extension.pluginId, extension.release));
  if (!checked.ok) warnOnce(`buyer-chrome-css:${extension.pluginId}:${extension.release}`, `${extension.pluginId}: ${checked.problem}, so the store draws its own header and footer on buyer pages.`);
  const value = checked.ok ? checked.text : false;
  if (checkedSheets.size >= CHECKED_SHEETS_MAX) checkedSheets.delete(checkedSheets.keys().next().value!);
  checkedSheets.set(key, value);
  return value;
}

/** Forgets the checked sheets and rebuilt markup this isolate keeps (tests). */
export function clearBuyerChromeMemo(): void {
  checkedSheets.clear();
  inertMemo.clear();
}

/** Rebuilt markup this isolate keeps, by its content, the links it was handed and the page's image origins (a skin's markup repeats on every page). */
const INERT_MEMO_MAX = 64;
const inertMemo = new Map<string, string | null>();

/** An image URL on this store under an app's proxy or the API: a request there reaches an app or acts, never draws a picture. */
function storeEndpointImage(src: string, origin: string): boolean {
  try {
    const url = new URL(src, origin || "https://store.invalid");
    if (origin && url.origin !== new URL(origin).origin) return false;
    return /^\/(?:apps|api)(?:\/|$)/i.test(decodeURIComponent(url.pathname));
  } catch {
    return true;
  }
}

/**
 * Checked app markup rebuilt for a buyer page (`inertChromeHtml`, an allow-list): no island,
 * script, style, frame or form; links only to store paths and to the URLs it was handed;
 * images only from the page's allowed origins. Null when it is over the rebuild's bound
 * (`INERT_MARKUP_MAX_BYTES`). The same markup is rebuilt once per isolate.
 */
export function inertHtml(html: string, links: ReadonlySet<string> = new Set()): string | null {
  const allowed = getRuntimePrivateImageOrigins() ?? [];
  const origin = getRuntimeStorefrontUrl();
  const key = `${origin} ${allowed.join(" ")}\u0000${[...links].sort().join("\u0001")}\u0000${html}`;
  const known = inertMemo.get(key);
  if (known !== undefined) return known;
  const rebuilt = inertChromeHtml(html, { imageAllowed: (src) => cspSourcesAllowImage(src, allowed, origin) && !storeEndpointImage(src, origin), links });
  if (inertMemo.size >= INERT_MEMO_MAX) inertMemo.delete(inertMemo.keys().next().value!);
  inertMemo.set(key, rebuilt);
  return rebuilt;
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
 * listing pages: their structured data is core's alone. A product_main
 * skin's SKU controls are bound to the buy form with `purchase`, which a
 * product page must pass (without it every buy button is drawn off).
 */
export async function renderAppSkin<Target extends StorefrontSkinTarget>(
  locals: object,
  url: URL,
  skin: AppSkin & { target: Target },
  ask: SkinAsk<Target>,
  ...purchase: Target extends "product_main" ? [purchase: PurchasePage] : []
): Promise<AppMarkup | null> {
  const { host } = await requestExtensions(locals, url);
  const jsonLd = skin.target !== "product_main" && skin.target !== "listing_main";
  const html = await host.render(skin.extension, {
    kind: "skin", target: skin.target, component: skin.component, settings: skin.settings, ...ask,
  } as never, { jsonLd });
  const markup = appMarkup(skin.extension, skin.target, html);
  // A product page skin's SKU controls join the store's buy form.
  return markup && skin.target === "product_main"
    ? bindPurchaseControls(markup, (ask as unknown as { data: StorefrontProductPage }).data.product, (purchase as PurchasePage[])[0] ?? { blocked: true, opening: null })
    : markup;
}

/** A component that fills a slot, with its settings resolved. */
export interface AppSlotComponent {
  extension: StorefrontExtension;
  /** The manifest component type. */
  type: string;
  /** The theme's id of the placement (product slots). */
  instanceId?: string;
  settings: StorefrontResolvedSettings;
  /**
   * A product slot component that declares object reads: its records for the
   * product shown, from the product template's part (empty when it answered none).
   */
  objects?: NonNullable<Extract<StorefrontRenderJob, { kind: "section" }>["objects"]>;
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
    return [{
      extension, instanceId: block.id, type: declaration.type,
      settings: resolveSkinSettings(declaration.settings, resolvePluginSettingBindings(declaration.settings, block.values, block.bindings, theme.bindingContext)),
      ...(declaration.reads ? { objects: theme.componentObjects?.get(block.id) ?? {} } : {}),
    }];
  });
}
