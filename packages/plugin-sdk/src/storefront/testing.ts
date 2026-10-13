// Tests for storefront modules: render a section or slot through the same
// batch protocol the storefront uses, with realistic fixture data.
//
//   import storefront from "./storefront";
//   import { renderSection, fixtureProductCard } from "@scalius/plugin-sdk/storefront/testing";
//
//   const html = renderSection(storefront, "hero", { heading: "Hello" });

import {
  STOREFRONT_COMPONENT_ABI,
  type StorefrontFooterData,
  type StorefrontHeaderData,
  type StorefrontModule,
  type StorefrontProductCard,
  type StorefrontRenderContext,
  type StorefrontRenderJob,
  type StorefrontResolvedSettings,
} from "@scalius/shared/plugins/storefront-protocol";
import { checkStorefrontHeaderHtml, type StorefrontHeaderCheckOptions } from "@scalius/shared/plugins/storefront-html-check";
import { sanitizePluginHtml } from "@scalius/shared/plugins/html";

export { checkStorefrontHeaderHtml } from "@scalius/shared/plugins/storefront-html-check";

/**
 * What the storefront shows of a component's markup (the host's sanitizer),
 * and how many elements and attributes it left out: assert `dropped` is 0.
 */
export function storefrontShown(html: string, pluginId: string): { html: string; dropped: number } {
  const result = sanitizePluginHtml(html, { pluginId, profile: "component" });
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
    price: { amount: 1200, formatted: "৳1,200" },
    compareAt: { amount: 1500, formatted: "৳1,500" },
    priceVaries: false,
    percentOff: 20,
    image: { url: "https://media.example.com/shirt-480.webp", srcset: "https://media.example.com/shirt-480.webp 480w, https://media.example.com/shirt-960.webp 960w", width: 960, height: 1200, alt: "Linen shirt" },
    hoverImage: null,
    soldOut: false,
    rating: { average: 4.6, count: 12 },
    quickAdd: true,
    needsOptions: false,
    facts: [],
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

export function renderHeader(module: StorefrontModule, component: string, settings: StorefrontResolvedSettings = {}, data: Partial<StorefrontHeaderData> = {}, options: RenderOptions = {}): string {
  const html = renderOne(module, { id: "job_1", kind: "slot", slot: "header", component, settings, data: fixtureHeaderData(data) }, options);
  try {
    assertHeaderContract(html, options);
  } catch (error) {
    throw new Error(`Header ${JSON.stringify(component)}: ${(error as Error).message}`);
  }
  return html;
}

export function renderFooter(module: StorefrontModule, component: string, settings: StorefrontResolvedSettings = {}, data: Partial<StorefrontFooterData> = {}, options: RenderOptions = {}): string {
  return renderOne(module, { id: "job_1", kind: "slot", slot: "footer", component, settings, data: fixtureFooterData(data) }, options);
}

export function renderProductCard(module: StorefrontModule, component: string, settings: StorefrontResolvedSettings = {}, product: Partial<StorefrontProductCard> = {}, options: RenderOptions = {}): string {
  return renderOne(module, {
    id: "job_1", kind: "slot", slot: "product-card", component, settings,
    data: { product: fixtureProductCard(product), position: 0, aboveFold: false },
  }, options);
}
