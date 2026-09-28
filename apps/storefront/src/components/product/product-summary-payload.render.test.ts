// @vitest-environment node
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import type { Product, ProductOptionDefinition, ProductVariant } from "@/lib/api";
import { STOREFRONT_BUY_BOX_LOOKS, type StorefrontBuyBoxLook } from "@scalius/shared/storefront-theme";
import { getBuyerStockSummary } from "@/lib/product-sellable-variants";
import { buyBoxFeatures } from "./lib/product-page-modules";
import { resolveExactVariantSelection, validateSelection } from "./lib/variant-state-machine";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const virtualModules: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};

let server: ViteDevServer;
let container: { renderToString(component: unknown, options: { props: object; request: Request; slots?: Record<string, string> }): Promise<string> };
let ProductSummary: unknown;
let ProductFeatureList: unknown;

beforeAll(async () => {
  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  const configure = getViteConfig({
    root,
    logLevel: "error",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom",
    plugins: [{
      name: "product-summary-payload-test-modules",
      resolveId: (id: string) => (id in virtualModules ? `\0summary-test:${id}` : undefined),
      load: (id: string) => id.startsWith("\0summary-test:") ? virtualModules[id.slice("\0summary-test:".length)] : undefined,
    }],
  } as never, { configFile: false, root, logLevel: "error", devToolbar: { enabled: false } } as never) as unknown as
    (env: { mode: string; command: string }) => Promise<object>;
  server = await createServer({ ...(await configure({ mode: "test", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
  const reactRenderer = (await server.ssrLoadModule("@astrojs/react/server.js")).default;
  container = await experimental_AstroContainer.create();
  (container as unknown as { addServerRenderer(renderer: object): void }).addServerRenderer({
    name: "@astrojs/react",
    renderer: reactRenderer,
  });
  ProductSummary = (await server.ssrLoadModule("/src/components/product/ProductSummary.astro")).default;
  ProductFeatureList = (await server.ssrLoadModule("/src/components/product/modules/ProductFeatureList.astro")).default;
}, 120_000);

afterAll(async () => { await server?.close(); });

const options: ProductOptionDefinition[] = [
  { id: "model", name: "Model", position: 0, standardMapping: "none", values: Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, value: `Model ${i}`, position: i })) },
  { id: "color", name: "Color", position: 1, standardMapping: "color", values: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, value: `Color ${i}`, position: i })) },
];
const variants: ProductVariant[] = Array.from({ length: 100 }, (_, i) => ({
  id: `sku_${i}`,
  productId: "prod_1",
  optionCombinationKey: `m${Math.floor(i / 10)}|c${i % 10}`,
  imageId: i === 42 ? "product_media_42" : null,
  imageUrl: i === 42 ? "https://shop.test/media/sku42.webp" : null,
  imageMediaId: i === 42 ? "media_42" : null,
  selectedOptions: [
    { optionDefinitionId: "model", optionValueId: `m${Math.floor(i / 10)}`, name: "Model", value: `Model ${Math.floor(i / 10)}`, position: 0, valuePosition: Math.floor(i / 10), standardMapping: "none" },
    { optionDefinitionId: "color", optionValueId: `c${i % 10}`, name: "Color", value: `Color ${i % 10}`, position: 1, valuePosition: i % 10, standardMapping: "color" },
  ],
  weight: null,
  sku: `SC-${i}`,
  price: 300 + i,
  stock: i === 1 ? 0 : 5,
  reservedStock: 0,
  availabilityBand: i === 1 ? "out_of_stock" : "in_stock",
  isDefault: false,
  trackInventory: true,
  lowStockThreshold: 2,
  barcode: `200000000${String(i).padStart(4, "0")}`,
  barcodeType: "ean13",
  discountType: i === 42 ? "percentage" : null,
  discountPercentage: i === 42 ? 10 : null,
  discountAmount: null,
  fulfillmentKind: "physical",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  deletedAt: null,
}));

describe("product summary browser payload", () => {
  it("places only saved mall highlights between the title and price", async () => {
    const request = new Request("https://shop.test/products/game-key");
    const render = async (features: string[]) => {
      const product = {
        id: "prod_1", slug: "game-key", name: "Game key", price: 1200,
        features,
        attributes: [{ name: "Region", value: "US", slug: "region", group: null, unit: null, keySpec: true }],
      } as Product;
      const bullets = await container.renderToString(ProductFeatureList, {
        props: { features: buyBoxFeatures(product, true), variant: "bullets", compact: true }, request,
      });
      const html = await container.renderToString(ProductSummary, {
        props: { product, category: null, variants: [], options: [], details: false, look: STOREFRONT_BUY_BOX_LOOKS.mall },
        slots: { "after-title": bullets }, request,
      });
      const doc = new Window().document;
      doc.write(`<body>${html}</body>`);
      return doc;
    };
    const populated = await render(["Redeem on a US account", "Delivery by email"]);
    const title = populated.querySelector("h1")!;
    const list = populated.querySelector('[data-product-features="bullets"]')!;
    const price = populated.querySelector(".buy-box-main-price")!;
    expect(list.textContent).toContain("Redeem on a US account");
    expect(list.className).toContain("space-y-0.5");
    expect(title.compareDocumentPosition(list) & 4).toBe(4);
    expect(list.compareDocumentPosition(price) & 4).toBe(4);
    expect(populated.querySelectorAll('[data-product-features="bullets"]')).toHaveLength(1);
    expect((await render([])).querySelector('[data-product-features="bullets"]')).toBeNull();
  });

  it("places fashion copy after its purchase card in the photo's info column", async () => {
    const product = {
      id: "prod_1", slug: "tunic", name: "Cotton tunic", price: 300,
      description: "<p>Soft cotton for everyday wear.</p>",
      additionalInfo: [{ id: "fabric", title: "Fabric & care", content: "<p>Machine wash cold.</p>" }],
    } as Product;
    const html = await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: [], options: [], details: true, look: STOREFRONT_BUY_BOX_LOOKS.fashion },
      request: new Request("https://shop.test/products/tunic"),
    });
    const doc = new Window().document;
    doc.write(`<body>${html}</body>`);
    const summary = doc.querySelector("[data-product-summary]")!;
    const details = summary.querySelector("[data-product-details-plain]")!;
    expect(details.parentElement).toBe(summary);
    expect(summary.querySelector(".buy-box-body #product-details")).toBeNull();
    expect(details.textContent).toContain("Soft cotton for everyday wear.");
    expect(details.textContent).toContain("Fabric & care");
    expect(details.querySelector("[role=tab]")).toBeNull();
  });

  it("keeps mall quantity and purchase buttons in one opt-in desktop row", async () => {
    const product = { id: "prod_1", slug: "sample", name: "Sample", price: 300 } as Product;
    const html = await container.renderToString(ProductSummary, {
      props: { product, category: null, variants, options, details: false, look: STOREFRONT_BUY_BOX_LOOKS.mall },
      request: new Request("https://shop.test/products/sample"),
    });
    const doc = new Window().document;
    doc.write(`<body>${html}</body>`);

    expect(doc.querySelector("[data-product-summary]")?.hasAttribute("data-quantity-inline")).toBe(true);
    expect(doc.querySelector("label[for=quantity]")?.classList.contains("lg:sr-only")).toBe(true);
    expect(doc.querySelectorAll(".buy-box-ctas button")).toHaveLength(2);
    expect(doc.querySelector("#quantity")?.getAttribute("form")).toBe("product-buy-form");
    expect(doc.querySelector("[data-action=buy-now]")?.getAttribute("form")).toBe("product-buy-form");
  });

  it("groups arbitrary merchant options in rounded-tech panels without changing purchase controls", async () => {
    const product = { id: "prod_1", slug: "sample", name: "Sample", price: 300 } as Product;
    const html = await container.renderToString(ProductSummary, {
      props: { product, category: null, variants, options, details: false, look: STOREFRONT_BUY_BOX_LOOKS.tech },
      request: new Request("https://shop.test/products/sample"),
    });
    const doc = new Window().document;
    doc.write(`<body>${html}</body>`);

    const panels = doc.querySelector(".variant-option-panels");
    expect([...panels!.children].map((panel) => panel.querySelector("legend")?.textContent)).toEqual(["Model", "Color"]);
    expect(panels?.querySelectorAll(".variant-option-btn")).toHaveLength(20);
    expect(panels?.querySelectorAll(".variant-option-values[data-option-overflow]")).toHaveLength(2);
    expect(doc.querySelector("[data-product-summary]")?.getAttribute("data-cta-phone-layout")).toBe("row");
    expect(doc.querySelectorAll(".buy-box-ctas button")).toHaveLength(2);
    expect(doc.querySelector("#product-variant-noscript")?.getAttribute("form")).toBe("product-buy-form");

    const fewOptions = options.map((option) => ({ ...option, values: option.values.slice(0, 3) }));
    const fewHtml = await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: variants.filter((variant) => variant.selectedOptions.every((choice) => Number(choice.optionValueId.slice(1)) < 3)), options: fewOptions, details: false, look: STOREFRONT_BUY_BOX_LOOKS.tech },
      request: new Request("https://shop.test/products/sample"),
    });
    const fewDoc = new Window().document;
    fewDoc.write(`<body>${fewHtml}</body>`);
    expect(fewDoc.querySelectorAll(".variant-option-btn")).toHaveLength(6);
    expect(fewDoc.querySelector(".variant-option-values[data-option-overflow]")).toBeNull();
  });

  it("keeps exact SKU selection, prices and availability in a compact 100-SKU payload", async () => {
    const product = { id: "prod_1", slug: "sample", name: "Sample", price: 300, discountType: null, discountPercentage: null, discountAmount: null } as Product;
    const html = await container.renderToString(ProductSummary, {
      props: { product, category: null, variants, options, details: false, currencyCode: "BDT", currencyDecimalPlaces: 2 },
      request: new Request("https://shop.test/products/sample"),
    });
    const doc = new Window().document;
    doc.write(`<body>${html}</body>`);
    const variantScript = doc.querySelector("#product-variants-data")?.textContent ?? "";
    const optionScript = doc.querySelector("#product-options-data")?.textContent ?? "";
    const browserVariants = JSON.parse(variantScript);
    const browserOptions = JSON.parse(optionScript);

    expect(browserVariants).toHaveLength(100);
    expect(Buffer.byteLength(variantScript)).toBeLessThan(70_000);
    expect(Buffer.byteLength(variantScript)).toBeLessThan(Buffer.byteLength(JSON.stringify(variants)) * 0.7);
    expect(browserOptions[0]).toEqual({ id: "model", name: "Model", values: options[0]!.values.map(({ id }) => ({ id })) });
    expect(resolveExactVariantSelection(browserVariants, { model: "m4", color: "c2" })?.variant).toMatchObject({
      id: "sku_42", price: 342, discountedPrice: 308, imageId: "product_media_42", imageMediaId: "media_42",
    });
    expect(validateSelection({ model: "m0", color: "c1" }, browserOptions, browserVariants).valid).toBe(false);
    expect(validateSelection({ model: "m4", color: "c2" }, browserOptions, browserVariants).valid).toBe(true);
    expect(getBuyerStockSummary([browserVariants[1]!]).text).toBe("Out of Stock");
    expect(doc.querySelectorAll("#product-variant-noscript option")).toHaveLength(99);
  });

  it("shows only saved Marketplace facts after desktop option selectors, with key specs first", async () => {
    const attributes: NonNullable<Product["attributes"]> = [
      { name: "Material", value: "Aluminium", slug: "material", group: null, unit: null, keySpec: false },
      { name: "Capacity", value: "2", slug: "capacity", group: null, unit: "TB", keySpec: true },
      { name: "Empty", value: " ", slug: "empty", group: null, unit: null, keySpec: false },
      { name: "Warranty", value: "2 years", slug: "warranty", group: null, unit: null, keySpec: true },
      { name: "Brand", value: "Example", slug: "brand", group: null, unit: null, keySpec: false },
      { name: "Interface", value: "PCIe", slug: "interface", group: null, unit: null, keySpec: false },
      { name: "Feature", value: "Long description", slug: "feature", group: null, unit: null, keySpec: false },
    ];
    const product = { id: "prod_1", slug: "sample", name: "Sample", price: 300, brand: { name: "Record Brand" }, attributes } as Product;
    const html = await container.renderToString(ProductSummary, {
      props: { product, category: null, variants, options, details: false, look: STOREFRONT_BUY_BOX_LOOKS["marketplace-3col"] },
      request: new Request("https://shop.test/products/sample"),
    });
    const doc = new Window().document;
    doc.write(`<body>${html}</body>`);
    const facts = doc.querySelector("[data-product-compact-facts]");

    expect(facts?.classList.contains("hidden")).toBe(true);
    expect(facts?.classList.contains("lg:block")).toBe(true);
    expect([...facts!.querySelectorAll("dt")].map((row) => row.textContent)).toEqual([
      "Brand", "Capacity", "Warranty", "Material", "Interface",
    ]);
    expect(facts?.querySelector("dd")?.textContent).toBe("Record Brand");
    expect([...facts!.querySelectorAll("dd")].map((row) => row.textContent)).toContain("2 TB");
    expect(doc.querySelectorAll(".variant-option-selector")).toHaveLength(2);
    expect(doc.querySelectorAll(".variant-option-selector")[1]!.compareDocumentPosition(facts!) & 4).toBe(4);
    const largeModel = doc.querySelector('[data-option-definition-id="model"][data-option-value-id="m1"].variant-option-btn');
    expect(largeModel?.querySelector("[data-option-price]")?.textContent).toContain("310");
    expect(largeModel?.getAttribute("aria-label")).toContain("310");
    const soldOutColor = doc.querySelector('[data-option-definition-id="color"][data-option-value-id="c1"].variant-option-btn');
    expect(soldOutColor?.querySelector("[data-option-price]")?.hasAttribute("hidden")).toBe(true);

    const flatHtml = await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: variants.map((variant) => ({ ...variant, price: 300, discountType: null })), options, details: false, look: STOREFRONT_BUY_BOX_LOOKS["marketplace-3col"] },
      request: new Request("https://shop.test/products/sample"),
    });
    const flatDoc = new Window().document;
    flatDoc.write(`<body>${flatHtml}</body>`);
    expect(flatDoc.querySelectorAll("[data-option-price]:not([hidden])")).toHaveLength(0);

    const withoutFacts = { ...product, brand: null, attributes: [] };
    const emptyHtml = await container.renderToString(ProductSummary, {
      props: { product: withoutFacts, category: null, variants: [], options: [], details: false, look: STOREFRONT_BUY_BOX_LOOKS["marketplace-3col"] },
      request: new Request("https://shop.test/products/sample"),
    });
    expect(emptyHtml).not.toContain("data-product-compact-facts");

    const otherHtml = await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: [], options: [], details: false, look: STOREFRONT_BUY_BOX_LOOKS.spec },
      request: new Request("https://shop.test/products/sample"),
    });
    expect(otherHtml).not.toContain("data-product-compact-facts");
  });

  it("shows only truthful Star Tech fact pills while keeping the live price and stock nodes", async () => {
    const product = {
      id: "prod_1", slug: "laptop", name: "Laptop", price: 60_500,
      discountType: "flat", discountPercentage: null, discountAmount: 3_500,
      brand: { id: "acer", name: "Acer", slug: "acer" },
    } as Product;
    const simpleVariant = {
      ...variants[0]!, selectedOptions: [], optionCombinationKey: null,
      sku: "LAP-57", price: 60_500,
    };
    const html = await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: [simpleVariant], options: [], details: false, look: STOREFRONT_BUY_BOX_LOOKS.spec },
      request: new Request("https://shop.test/products/laptop"),
    });
    const doc = new Window().document;
    doc.write(`<body>${html}</body>`);

    const factRow = doc.querySelector("[data-fact-pills] .buy-box-main-price")!;
    expect(factRow.textContent).toContain("Price:");
    expect(factRow.textContent).toContain("Regular Price:");
    expect(factRow.textContent).toContain("Status:In Stock");
    expect(factRow.textContent).toContain("Product Code:LAP-57");
    expect(factRow.textContent).toContain("Brand:Acer");
    expect(doc.querySelectorAll(".product-price")).toHaveLength(1);
    expect(doc.querySelectorAll("#product-stock-text")).toHaveLength(1);
    expect(doc.querySelector(".product-original-price")?.classList.contains("hidden")).toBe(false);

    const variableHtml = await container.renderToString(ProductSummary, {
      props: { product: { ...product, discountType: null, discountAmount: null, brand: null }, category: null, variants, options, details: false, look: STOREFRONT_BUY_BOX_LOOKS.spec },
      request: new Request("https://shop.test/products/laptop"),
    });
    const variableDoc = new Window().document;
    variableDoc.write(`<body>${variableHtml}</body>`);
    const variableFacts = variableDoc.querySelector("[data-fact-pills] .buy-box-main-price")!;
    expect(variableFacts.textContent).not.toContain("Product Code:");
    expect(variableFacts.textContent).not.toContain("Brand:");
    expect(variableDoc.querySelector(".product-original-price")?.classList.contains("hidden")).toBe(true);
  });

  it("keeps a single apparel purchase action with sparse or option-rich products, unless the merchant enables Buy now", async () => {
    const product = { id: "prod_1", slug: "sample", name: "Sample", price: 300 } as Product;
    const sparseVariant = { ...variants[0]!, selectedOptions: [], optionCombinationKey: null };
    const renderActions = async (look: StorefrontBuyBoxLook, rich: boolean, addToCartText?: string) => {
      const html = await container.renderToString(ProductSummary, {
        props: { product, category: null, variants: rich ? variants : [sparseVariant], options: rich ? options : [], details: false, look, actionCopy: addToCartText ? { addToCartText } : undefined },
        request: new Request("https://shop.test/products/sample"),
      });
      const doc = new Window().document;
      doc.write(`<body>${html}</body>`);
      return doc;
    };
    for (const look of [STOREFRONT_BUY_BOX_LOOKS.fashion, STOREFRONT_BUY_BOX_LOOKS.heritage]) {
      for (const rich of [false, true]) {
        const doc = await renderActions(look, rich);
        expect(doc.querySelectorAll('[data-action="add-to-cart"]')).toHaveLength(1);
        expect(doc.querySelector('[data-action="buy-now"]')).toBeNull();
        expect(doc.querySelector('[data-action="add-to-cart"] svg')).toBeNull();
        expect(doc.querySelectorAll(".variant-option-selector")).toHaveLength(rich ? 2 : 0);
      }
    }
    const longLabel = "Add this handwoven item to my bag";
    expect((await renderActions(STOREFRONT_BUY_BOX_LOOKS.fashion, false, longLabel)).querySelector('[data-action-label="add-to-cart"]')?.textContent).toBe(longLabel);
    const merchantLook = { ...STOREFRONT_BUY_BOX_LOOKS.fashion, cta: { ...STOREFRONT_BUY_BOX_LOOKS.fashion.cta, showBuyNow: true } };
    expect((await renderActions(merchantLook, false)).querySelectorAll(".buy-box-ctas button")).toHaveLength(2);
  });
});
