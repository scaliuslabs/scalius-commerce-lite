// @vitest-environment node
/**
 * Render-only listing coverage (no browser): renders the real catalog Astro
 * components with Astro's container API for every listing layout, toolbar
 * piece, phone layout and paging mode, and checks the markup each promises.
 * The default layout (sidebar-grid) must render exactly the markup it
 * rendered before the listing templates (the baselines in __fixtures__).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import {
  DEFAULT_STOREFRONT_THEME,
  storeShapeFromFacts,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { requestThemeFor } from "@/lib/storefront-theme-context";
import { resolveProductListQueryState } from "@/lib/product-list-query";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const fixtures = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};

interface Container {
  renderToString(
    component: unknown,
    options: { props?: object; slots?: Record<string, string>; locals?: object; request?: Request },
  ): Promise<string>;
}

let server: ViteDevServer;
let container: Container;

beforeAll(async () => {
  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  const configure = getViteConfig(
    {
      root,
      logLevel: "error",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: "custom",
      plugins: [
        {
          name: "catalog-render-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0catalog-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0catalog-test:") ? VIRTUAL_MODULES[id.slice("\0catalog-test:".length)] : undefined,
        },
      ],
    } as never,
    { configFile: false, root, logLevel: "error", devToolbar: { enabled: false } } as never,
  ) as unknown as (env: { mode: string; command: string }) => Promise<object>;
  server = await createServer({ ...(await configure({ mode: "test", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
  const reactRenderer = (await server.ssrLoadModule("@astrojs/react/server.js")).default;
  container = await experimental_AstroContainer.create();
  (container as unknown as { addServerRenderer(renderer: object): void }).addServerRenderer({
    name: "@astrojs/react",
    renderer: reactRenderer,
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const STORE_SHAPE = storeShapeFromFacts({
  productCount: 120,
  skuCount: 300,
  topCategoryCount: 8,
  categoryDepth: 1,
  menu: [],
  hasCollections: true,
  hasDeliveryMethods: true,
});

async function render(
  path: string,
  theme: StorefrontThemeDocument,
  props: object,
  slots?: Record<string, string>,
): Promise<string> {
  const component = (await server.ssrLoadModule(path)).default;
  return container.renderToString(component, {
    props,
    slots,
    locals: { storefrontTheme: Promise.resolve(requestThemeFor(theme, STORE_SHAPE)) },
    request: new Request("https://shop.test/categories/sarees"),
  });
}

/** Astro's per-build ids differ between runs; the markup must not. */
function normalize(html: string): string {
  return html
    .replace(/ data-astro-cid-[a-z0-9]+(="")?/g, "")
    .replace(/astro-[a-z0-9]{8}/g, "astro-cid")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<link\b[^>]*>/g, "");
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const image = (name: string) => `https://cdn.shop.test/products/${name}.jpg`;
function product(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Product ${id}`,
    slug: `product-${id}`,
    description: null,
    price: 1200,
    discountedPrice: 1200,
    discountType: null,
    discountPercentage: null,
    discountAmount: null,
    freeDelivery: false,
    isActive: true,
    metaTitle: null,
    metaDescription: null,
    categoryId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
    imageUrl: image(id),
    imageAlt: null,
    hasVariants: false,
    availableForSale: true,
    ...overrides,
  };
}

const PRODUCTS = Array.from({ length: 20 }, (_, index) =>
  product(`p${index + 1}`, index % 5 === 0 ? { discountedPrice: 960, discountType: "percentage", discountPercentage: 20 } : {}));
const FACETS = [
  {
    id: "attr-size",
    name: "Size",
    slug: "size",
    values: [
      { value: "S", count: 12 },
      { value: "M", count: 20 },
      { value: "L", count: 0 },
    ],
  },
  {
    id: "attr-fabric",
    name: "Fabric",
    slug: "fabric",
    values: Array.from({ length: 14 }, (_, index) => ({ value: `Fabric ${index + 1}`, count: index + 1 })),
  },
  { id: "attr-single", name: "Origin", slug: "origin", values: [{ value: "Bangladesh", count: 50 }] },
];

function listingProps(url: string, overrides: Record<string, unknown> = {}) {
  const queryState = resolveProductListQueryState({ url: new URL(url), facets: FACETS });
  return {
    products: PRODUCTS,
    pagination: { page: queryState.page, totalPages: 3, total: 50 },
    facets: FACETS,
    priceRange: { min: 500, max: 4500 },
    queryState,
    pathname: new URL(url).pathname,
    resetPath: new URL(url).pathname,
    searchLabel: "Search this category",
    countEndpoint: "/categories/sarees/products",
    currencySymbol: "৳",
    currencyCode: "BDT",
    ...overrides,
  };
}

const EMPTY_SLOT = { empty: '<section data-catalog-empty-state>Nothing here</section>' };

/** The default (sidebar-grid) listing states whose markup must not change. */
const BASELINES: Record<string, () => Record<string, unknown>> = {
  plain: () => listingProps("https://shop.test/categories/sarees"),
  filtered: () =>
    listingProps("https://shop.test/categories/sarees?size=M&fabric=Fabric+12&minPrice=600&hasDiscount=true&page=2&sortBy=price-asc"),
  search: () =>
    listingProps("https://shop.test/search?q=linen", { pathname: "/search", resetPath: "/search?q=linen", searchLabel: "Search products", countEndpoint: "/products" }),
  empty: () =>
    listingProps("https://shop.test/categories/sarees?size=L", { products: [], pagination: { page: 1, totalPages: 0, total: 0 } }),
};

describe("default listing (sidebar-grid)", () => {
  it.each(Object.keys(BASELINES))("renders the %s state exactly as before", async (name) => {
    const html = normalize(
      await render("/src/components/catalog/CatalogListing.astro", DEFAULT_STOREFRONT_THEME, BASELINES[name]!(), EMPTY_SLOT),
    );
    const file = `${fixtures}sidebar-grid-${name}.html`;
    if (process.env.UPDATE_CATALOG_BASELINE === "1") {
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(file, html);
    }
    expect(html).toBe(readFileSync(file, "utf8"));
  });
});
