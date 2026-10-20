// @vitest-environment node
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import type { Product, ProductOptionDefinition, ProductVariant } from "@/lib/api";
import type { StorefrontListingPage, StorefrontProductPage } from "@scalius/shared/plugins/storefront-protocol";
import { storefrontEmbedRule } from "@scalius/shared/plugins/storefront-components";
import { splitStorefrontEmbeds } from "@scalius/shared/plugins/storefront-embeds";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { DEFAULT_STOREFRONT_THEME } from "@scalius/shared/storefront-theme";
import { requestThemeFor } from "@/lib/storefront-theme-context";
import { resolveProductListQueryState } from "@/lib/product-list-query";
import { listingPageData, productCardsOf, productPageData } from "./data";
import { shopCopy } from "@/lib/storefront-shop-copy";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const virtualModules: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
let server: ViteDevServer;
let container: { renderToString(component: unknown, options: { props: object; request: Request; locals?: object }): Promise<string> };
let ProductBuyBox: unknown;
let AppComponent: unknown;

beforeAll(async () => {
  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  const configure = getViteConfig({
    root, logLevel: "error", appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    plugins: [{
      name: "fidelity-test-modules",
      resolveId: (id: string) => id in virtualModules ? `\0fidelity-test:${id}` : undefined,
      load: (id: string) => id.startsWith("\0fidelity-test:") ? virtualModules[id.slice("\0fidelity-test:".length)] : undefined,
    }],
  } as never, { configFile: false, root, logLevel: "error", devToolbar: { enabled: false } } as never) as unknown as
    (env: { mode: string; command: string }) => Promise<object>;
  server = await createServer({ ...(await configure({ mode: "test", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
  container = await experimental_AstroContainer.create();
  (container as unknown as { addServerRenderer(renderer: object): void }).addServerRenderer({
    name: "@astrojs/react", renderer: (await server.ssrLoadModule("@astrojs/react/server.js")).default,
  });
  ProductBuyBox = (await server.ssrLoadModule("/src/components/product/ProductBuyBox.astro")).default;
  AppComponent = (await server.ssrLoadModule("/src/components/apps/AppComponent.astro")).default;
}, 120_000);
afterAll(async () => { await server?.close(); });

const product = {
  id: "shirt", slug: "linen-shirt", name: "Linen shirt", price: 200,
  discountType: "percentage", discountPercentage: 10, discountAmount: null,
  description: "<p>Pure linen</p>", customFields: [{ namespace: "details", key: "fabric", value: "Linen" }],
} as Product;
const options: ProductOptionDefinition[] = [{
  id: "colour", name: "Colour", position: 0, standardMapping: "color",
  values: ["Sand", "Navy"].map((value, position) => ({ id: value.toLowerCase(), value, position })),
}];
const variants = options[0]!.values.map((value, index) => ({
  id: `sku_${value.id}`, productId: product.id, sku: value.id,
  selectedOptions: [{ optionDefinitionId: "colour", optionValueId: value.id, name: "Colour", value: value.value, position: 0, valuePosition: index, standardMapping: "color" }],
  price: index === 0 ? 120 : 180, discountType: null, discountPercentage: null, discountAmount: null,
  stock: index === 0 ? 5 : 0, reservedStock: 0, trackInventory: true,
  availabilityBand: index === 0 ? "in_stock" : "out_of_stock", lowStockThreshold: 2,
  fulfillmentKind: "physical", imageId: null, imageUrl: null,
})) as ProductVariant[];
const projection = productPageData({
  product, media: [], variants, options, url: "/products/linen-shirt",
  breadcrumbs: [{ title: "Home", url: "/" }, { title: product.name, url: "/products/linen-shirt" }],
  price: { current: 108, regular: 120, from: false },
  variantPrice: (variant) => (variant.price ?? product.price) * 0.9,
  page: { currencyCode: "USD", currencySymbol: "$" },
});
const buyBox = {
  summary: { product, category: null, variants, options, details: false, currencyCode: "USD", currencySymbol: "$" },
  reviewCopy: ENGLISH_CHECKOUT_LANGUAGE_DATA,
  features: { shown: false, title: "Features" }, emi: false, contactLinks: [], contactCopy: shopCopy("en").product.contact,
  blockData: () => projection, fulfilment: "physical", deliveryFacts: [], canPurchaseAny: true,
};
const documentOf = (markup: string) => {
  const document = new Window().document;
  document.body.innerHTML = markup;
  return document;
};

// A skin owns its heading and description, and hands the purchase form to core.
const referenceSkin = ({ product }: StorefrontProductPage) =>
  `<h1>${product.title}</h1><p data-skin-price>${product.price.formatted}</p><s data-skin-regular>${product.compareAt?.formatted ?? ""}</s>${product.descriptionHtml}<scalius-embed kind="buy-form" data-title="false"></scalius-embed>`;

describe("core and skin projection fidelity", () => {
  it("renders the same title, prices, SKU choices and purchase form through the real embed renderer", async () => {
    const request = new Request("https://shop.test/products/linen-shirt");
    const core = documentOf(await container.renderToString(ProductBuyBox, { props: buyBox, request }));
    const split = splitStorefrontEmbeds(referenceSkin(projection), storefrontEmbedRule("product-main"));
    expect(split.missing).toEqual([]);
    const skin = documentOf(await container.renderToString(AppComponent, {
      request,
      props: {
        markup: { pluginId: "test.reference", base: "/_x/test.reference/release/", parts: split.parts, embeds: new Set(["buy-form"]) },
        embeds: { "buy-form": ({ data }: { data: Record<string, string> }) => ({
          component: ProductBuyBox, props: { ...buyBox, summary: { ...buyBox.summary, title: data.title !== "false" } },
        }) },
      },
    }));
    expect(core.querySelector("h1")?.textContent).toBe(skin.querySelector("h1")?.textContent);
    expect(core.querySelector(".product-price")?.textContent?.trim()).toBe(skin.querySelector("[data-skin-price]")?.textContent);
    expect(core.querySelector(".product-original-price")?.textContent?.trim()).toBe(skin.querySelector("[data-skin-regular]")?.textContent);
    expect(skin.querySelectorAll("h1")).toHaveLength(1);
    expect(skin.querySelectorAll('[data-sx-embed="buy-form"]')).toHaveLength(1);
    expect(skin.querySelector("#product-buy-form")?.outerHTML).toBe(core.querySelector("#product-buy-form")?.outerHTML);
    expect(skin.querySelector("#product-buy-form")?.getAttribute("method")).toBe("post");
    expect(skin.querySelector("#product-buy-form")?.getAttribute("action")).toBe("/buy/linen-shirt");
    const browserVariants = JSON.parse(core.querySelector("#product-variants-data")!.textContent!);
    expect(browserVariants.map((variant: { id: string; discountedPrice: number }) => [variant.id, variant.discountedPrice]))
      .toEqual(projection.product.variants.map((variant) => [variant.id, variant.price.amountMinor / 100]));
    expect(projection.product.price).toEqual({ amountMinor: 10800, currency: "USD", formatted: "$108" });
    expect(core.querySelectorAll("#product-variant-noscript option")).toHaveLength(1);
    expect(projection.product.variants.map((variant) => variant.available)).toEqual([true, false]);
    expect(projection.product.fields).toEqual({ "details.fabric": "Linen" });
  });

  it("renders the listing projection's title, breadcrumbs and crawlable pagination in core and a reference skin", async () => {
    const request = new Request("https://shop.test/categories/linen");
    const locals = { storefrontTheme: Promise.resolve(requestThemeFor(DEFAULT_STOREFRONT_THEME)) };
    const CatalogListingPage = (await server.ssrLoadModule("/src/components/catalog/CatalogListingPage.astro")).default;
    const CatalogEmbed = (await server.ssrLoadModule("/src/components/catalog/CatalogEmbed.astro")).default;
    const listing = {
      products: [{ ...product, discountedPrice: 180, hasVariants: true, availableForSale: true, imageUrl: null }],
      pagination: { page: 1, totalPages: 3, total: 50 },
      facets: [], queryState: resolveProductListQueryState({ url: new URL(request.url), facets: [] }),
      pathname: "/categories/linen", resetPath: "/categories/linen", searchLabel: "Search linen",
      countEndpoint: "/categories/linen/products", currencySymbol: "$", currencyCode: "USD",
    };
    const hero = { title: "Linen", count: 50, breadcrumb: [{ label: "Clothing", href: "/categories/clothing" }] };
    const data = listingPageData({
      kind: "category", title: hero.title, descriptionHtml: null, image: null,
      cards: productCardsOf(listing.products, { currencySymbol: "$", currencyCode: "USD", ratings: false }),
      pagination: listing.pagination, breadcrumbs: [{ label: "Home", href: "/" }, ...hero.breadcrumb], fields: {},
    });
    const referenceListing = (page: StorefrontListingPage) => `<h1>${page.title}</h1><nav aria-label="Breadcrumb">${page.breadcrumbs.map((crumb) => `<a href="${crumb.url}">${crumb.title}</a>`).join("")}</nav><scalius-embed kind="pagination"></scalius-embed>`;
    const split = splitStorefrontEmbeds(referenceListing(data), storefrontEmbedRule("listing-main"));
    const core = documentOf(await container.renderToString(CatalogListingPage, { request, locals, props: { kind: "category", listing, hero } }));
    const skin = documentOf(await container.renderToString(AppComponent, {
      request, locals, props: {
        markup: { pluginId: "test.reference", base: "/_x/test.reference/release/", parts: split.parts, embeds: new Set(["pagination"]) },
        embeds: { pagination: () => ({ component: CatalogEmbed, props: { kind: "pagination", listing } }) },
      },
    }));
    expect(core.querySelector("h1")?.textContent).toBe(data.title);
    expect(skin.querySelector("h1")?.textContent).toBe(data.title);
    const crumbs = (document: ReturnType<typeof documentOf>) => [...document.querySelectorAll('[aria-label="Breadcrumb"] a')].map((link) => [link.textContent, link.getAttribute("href")]);
    expect(crumbs(core)).toEqual(crumbs(skin));
    expect(crumbs(core)).toEqual([["Home", "/"], ["Clothing", "/categories/clothing"]]);
    expect(core.querySelector('[aria-label="Pagination"]')?.outerHTML).toBe(skin.querySelector('[aria-label="Pagination"]')?.outerHTML);
    expect(skin.querySelector('[aria-label="Next page"]')?.getAttribute("href")).toBe("/categories/linen?page=2");
  });
});
