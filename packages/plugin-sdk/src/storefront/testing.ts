// Tests for storefront modules: render a section, component or skin through the
// same batch protocol the storefront uses, with realistic fixture data. A
// skin's markup is held to its target's embed rule (a product_main skin must
// place exactly one buy form), as the storefront holds it.
//
//   import storefront from "./storefront";
//   import { renderSection, fixtureProductCard } from "@scalius/plugin-sdk/storefront/testing";
//
//   const html = renderSection(storefront, "hero", { heading: "Hello" });

import {
  STOREFRONT_COMPONENT_ABI,
  storefrontEmbedRule,
  type StorefrontComponentJob,
  type StorefrontComponentTarget,
  type StorefrontFooterData,
  type StorefrontHeaderData,
  type StorefrontListingPage,
  type StorefrontModule,
  type StorefrontProductCard,
  type StorefrontProductPage,
  type StorefrontRenderContext,
  type StorefrontRenderJob,
  type StorefrontResolvedSettings,
  type StorefrontSectionSkinData,
  type StorefrontSkinJob,
  type StorefrontSkinTarget,
  type StorefrontSkinUnit,
} from "@scalius/shared/plugins/storefront-protocol";
import { splitStorefrontEmbeds } from "@scalius/shared/plugins/storefront-embeds";
import { checkStorefrontHeaderHtml, type StorefrontHeaderCheckOptions } from "@scalius/shared/plugins/storefront-html-check";
import { sanitizePluginHtml } from "@scalius/shared/plugins/html";

export { checkStorefrontHeaderHtml } from "@scalius/shared/plugins/storefront-html-check";

/**
 * What the storefront shows of a component's markup (the host's sanitizer),
 * and how many elements and attributes it left out: assert `dropped` is 0.
 */
export function storefrontShown(html: string, pluginId: string): { html: string; dropped: number } {
  const result = sanitizePluginHtml(html, { pluginId });
  if (!result.ok) throw new Error(`The storefront would show nothing: ${result.reason}.`);
  return { html: result.html, dropped: result.dropped };
}

/** Assert declared header capabilities without requiring search, nav or account. */
export function assertHeaderContract(html: string, options: StorefrontHeaderCheckOptions = {}): void {
  const issues = checkStorefrontHeaderHtml(html, options);
  if (issues.length) throw new Error(`Invalid header markup: ${issues.join(" ")}`);
}

export function fixtureContext(overrides: Partial<StorefrontRenderContext> = {}): StorefrontRenderContext {
  return {
    store: { name: "Acme Store", currency: "BDT", locale: "en-BD", language: "en", timeZone: "Asia/Dhaka" },
    page: { kind: "home", path: "/" },
    assets: "/_x/acme.theme/0123456789abcdef/",
    preview: false,
    ...overrides,
  };
}

export function fixtureProductCard(overrides: Partial<StorefrontProductCard> = {}): StorefrontProductCard {
  return {
    id: "prod_1",
    title: "Linen shirt",
    url: "/products/linen-shirt",
    price: { amountMinor: 120000, currency: "BDT", formatted: "৳1,200" },
    compareAt: { amountMinor: 150000, currency: "BDT", formatted: "৳1,500" },
    priceVaries: false,
    percentOff: 20,
    image: { url: "https://media.example.com/shirt-480.webp", srcset: "https://media.example.com/shirt-480.webp 480w, https://media.example.com/shirt-960.webp 960w", width: 960, height: 1200, alt: "Linen shirt" },
    hoverImage: null,
    soldOut: false,
    rating: { average: 4.6, count: 12 },
    quickAdd: true,
    needsOptions: false,
    facts: [],
    fields: {},
    ...overrides,
  };
}

export function fixtureHeaderData(overrides: Partial<StorefrontHeaderData> = {}): StorefrontHeaderData {
  return {
    store: { name: "Acme Store", url: "/", logo: null, logoWidth: 140 },
    menu: [
      { title: "New in", url: "/collections/new", children: [] },
      { title: "Women", url: "/categories/women", children: [{ title: "Dresses", url: "/categories/dresses", children: [] }] },
    ],
    categories: [{ title: "Women", url: "/categories/women", children: [] }],
    announcement: { text: "Free delivery over ৳2,000", url: null },
    routes: { home: "/", search: "/search", cart: "/cart", account: "/account" },
    searchParam: "q",
    ...overrides,
  };
}

export function fixtureFooterData(overrides: Partial<StorefrontFooterData> = {}): StorefrontFooterData {
  return {
    store: {
      name: "Acme Store", url: "/", logo: null, logoWidth: 140, footerLogo: null,
      phone: "+8801700000000", email: "hello@acme.example", address: "Dhaka", social: [{ network: "facebook", url: "https://facebook.com/acme" }],
    },
    menus: [{ title: "Help", items: [{ title: "Shipping", url: "/pages/shipping", children: [] }] }],
    policies: [{ title: "Privacy", url: "/policies/privacy" }],
    newsletter: true,
    routes: { home: "/", newsletter: "/newsletter" },
    year: 2026,
    ...overrides,
  };
}

export function fixtureProductPage(overrides: Partial<StorefrontProductPage["product"]> = {}): StorefrontProductPage {
  const card = fixtureProductCard();
  return {
    product: {
      id: card.id,
      title: card.title,
      url: card.url,
      brand: { title: "Acme", url: "/brands/acme" },
      descriptionHtml: "<p>Breathable linen, cut for the heat.</p>",
      media: card.image ? [card.image] : [],
      price: card.price,
      compareAt: card.compareAt,
      priceVaries: false,
      availability: "in_stock",
      rating: card.rating,
      options: [{ name: "Size", values: [{ label: "M", swatch: null }, { label: "L", swatch: null }] }],
      variants: [
        { id: "sku_m", title: "M", options: ["M"], price: card.price, compareAt: card.compareAt, available: true, image: null },
        { id: "sku_l", title: "L", options: ["L"], price: card.price, compareAt: card.compareAt, available: false, image: null },
      ],
      fields: {},
      breadcrumbs: [{ title: "Home", url: "/" }, { title: "Shirts", url: "/categories/shirts" }, { title: card.title, url: card.url }],
      ...overrides,
    },
  };
}

export function fixtureListingPage(overrides: Partial<StorefrontListingPage> = {}): StorefrontListingPage {
  return {
    kind: "category",
    title: "Shirts",
    descriptionHtml: "<p>Shirts for every day.</p>",
    image: null,
    cards: [fixtureProductCard(), fixtureProductCard({ id: "prod_2", title: "Oxford shirt", quickAdd: false, compareAt: null, percentOff: null })],
    total: 2,
    totalIsCapped: false,
    page: 1,
    pageCount: 1,
    breadcrumbs: [{ title: "Home", url: "/" }],
    fields: {},
    ...overrides,
  };
}

/** A core section's projection with empty settings (pass the settings your skin reads). */
export function fixtureSectionSkinData(type: string, settings: Record<string, unknown> = {}): StorefrontSectionSkinData {
  return { type, version: 1, settings, tiles: [], cards: [] };
}

/** The projection a skin target gets (a `section:<type>` target: the section's). */
export type SkinData<Target extends StorefrontSkinTarget> = Target extends StorefrontSkinUnit
  ? Extract<StorefrontSkinJob, { target: Target }>["data"]
  : StorefrontSectionSkinData;

/** The fixture projection a skin target gets. */
export function fixtureSkinData(target: StorefrontSkinTarget): StorefrontSkinJob["data"] {
  switch (target) {
    case "header": return fixtureHeaderData();
    case "footer": return fixtureFooterData();
    case "product_card": return { product: fixtureProductCard(), position: 0, aboveFold: true };
    case "product_main": return fixtureProductPage();
    case "listing_main": return fixtureListingPage();
    default: return fixtureSectionSkinData(target.slice("section:".length));
  }
}

/** What the storefront would do with a skin's markup: the problems that make it draw the core unit instead. */
export function checkSkinHtml(target: StorefrontSkinTarget, html: string): string[] {
  const split = splitStorefrontEmbeds(html, storefrontEmbedRule(target));
  const issues = split.missing.map((kind) => `A ${target} skin must place <scalius-embed kind="${kind}"> (the SDK's ${kind === "buy_form" ? "<BuyForm />" : kind}); without it the store draws its own.`);
  if (split.dropped > 0) issues.push(`${split.dropped} embed(s) render nothing here: ${target} allows ${Object.keys(storefrontEmbedRule(target).allowed).join(", ") || "none"}.`);
  return issues;
}

export interface RenderOptions extends StorefrontHeaderCheckOptions {
  context?: Partial<StorefrontRenderContext>;
}

function renderOne(module: StorefrontModule, job: StorefrontRenderJob, options: RenderOptions): string {
  const reply = module.render({ abi: STOREFRONT_COMPONENT_ABI, context: fixtureContext(options.context), jobs: [job] });
  const result = reply.results[0];
  if (!result) throw new Error("The module answered no result.");
  if ("error" in result) throw new Error(result.error);
  return result.html;
}

/** A component section's HTML (throws what the component threw). */
export function renderSection(module: StorefrontModule, type: string, settings: StorefrontResolvedSettings = {}, options: RenderOptions = {}): string {
  return renderOne(module, { id: "job_1", kind: "section", type, instanceId: `app-${type}`, settings }, options);
}

/**
 * A component's HTML at one of its targets: in a product slot over the
 * fixture product page (or `data`), on `page` with `props` (what the proxy
 * route answers). Throws when the storefront would drop it: a component
 * places no embed (not even a slot).
 */
export function renderComponent(
  module: StorefrontModule,
  type: string,
  target: StorefrontComponentTarget,
  settings: StorefrontResolvedSettings = {},
  options: RenderOptions & { data?: StorefrontProductPage; props?: Record<string, unknown> } = {},
): string {
  const job = (target === "page"
    ? { target, props: options.props ?? {} }
    : target.startsWith("product.")
      ? { target, instanceId: `app-${type}`, data: options.data ?? fixtureProductPage() }
      : { target }) as Omit<StorefrontComponentJob, "id" | "kind" | "type" | "settings">;
  const html = renderOne(module, { id: "job_1", kind: "component", type, settings, ...job } as StorefrontComponentJob, options);
  const split = splitStorefrontEmbeds(html, storefrontEmbedRule("component"));
  if (split.dropped > 0) throw new Error(`Component ${JSON.stringify(type)} (${target}): ${split.dropped} embed(s) render nothing in a component.`);
  return html;
}

/**
 * A skin's HTML over its target's fixture projection (or yours). Throws
 * when the storefront would draw the core unit instead: a missing required
 * embed, an embed the target does not allow, or (headers) invalid markup.
 */
export function renderSkin<Target extends StorefrontSkinTarget>(
  module: StorefrontModule,
  component: string,
  target: Target,
  settings: StorefrontResolvedSettings = {},
  data?: SkinData<Target>,
  options: RenderOptions = {},
): string {
  const job = {
    id: "job_1", kind: "skin", target, component, settings,
    data: data ?? fixtureSkinData(target),
    ...(target.startsWith("section:") ? { instanceId: target.slice("section:".length) } : {}),
  } as StorefrontSkinJob;
  const html = renderOne(module, job, options);
  const issues = checkSkinHtml(target, html);
  if (target === "header") {
    try {
      assertHeaderContract(html, options);
    } catch (error) {
      issues.push((error as Error).message);
    }
  }
  if (issues.length > 0) throw new Error(`Skin ${JSON.stringify(component)} (${target}): ${issues.join(" ")}`);
  return html;
}

export function renderHeader(module: StorefrontModule, component: string, settings: StorefrontResolvedSettings = {}, data: Partial<StorefrontHeaderData> = {}, options: RenderOptions = {}): string {
  return renderSkin(module, component, "header", settings, fixtureHeaderData(data), options);
}

export function renderFooter(module: StorefrontModule, component: string, settings: StorefrontResolvedSettings = {}, data: Partial<StorefrontFooterData> = {}, options: RenderOptions = {}): string {
  return renderSkin(module, component, "footer", settings, fixtureFooterData(data), options);
}

export function renderProductCard(module: StorefrontModule, component: string, settings: StorefrontResolvedSettings = {}, product: Partial<StorefrontProductCard> = {}, options: RenderOptions = {}): string {
  return renderSkin(module, component, "product_card", settings, { product: fixtureProductCard(product), position: 0, aboveFold: false }, options);
}
