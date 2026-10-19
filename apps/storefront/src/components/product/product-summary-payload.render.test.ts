// @vitest-environment node
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import type { Product, ProductOptionDefinition, ProductVariant } from "@/lib/api";
import { STOREFRONT_BLOCK_REGISTRY, STOREFRONT_MARKETPLACE_BUY_BOX_LOOK } from "@scalius/shared/storefront-theme";
import { getBuyerStockSummary } from "@/lib/product-sellable-variants";
import { buyBoxFeatures } from "./lib/product-page-modules";
import { resolveExactVariantSelection, validateSelection } from "./lib/variant-state-machine";

// A classic buy box with these settings (the one box; its arrangement is all that differs).
const classic = (settings: Record<string, unknown> = {}) =>
  STOREFRONT_BLOCK_REGISTRY.buyBox.classic.renders({ ...STOREFRONT_BLOCK_REGISTRY.buyBox.classic.defaults, ...settings } as never).look;

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

const html = (markup: string) => {
  const doc = new Window().document;
  doc.write(`<body>${markup}</body>`);
  return doc;
};
const request = (slug: string) => new Request(`https://shop.test/products/${slug}`);

describe("product summary browser payload", () => {
  it("places only saved key features after the purchase buttons, so the price and buttons come first", async () => {
    const render = async (features: string[]) => {
      const product = {
        id: "prod_1", slug: "game-key", name: "Game key", price: 1200,
        features,
        attributes: [{ name: "Region", value: "US", slug: "region", group: null, unit: null, keySpec: true }],
      } as Product;
      const list = await container.renderToString(ProductFeatureList, {
        props: { features: buyBoxFeatures(product, true), variant: "list" }, request: request("game-key"),
      });
      return html(await container.renderToString(ProductSummary, {
        props: { product, category: null, variants: [], options: [], details: false, look: classic({ features: true, details: "below" }) },
        slots: { "after-actions": list }, request: request("game-key"),
      }));
    };
    const populated = await render(["Redeem on a US account", "Delivery by email"]);
    const price = populated.querySelector(".buy-box-main-price")!;
    const buttons = populated.querySelector(".buy-box-ctas")!;
    const list = populated.querySelector('[data-product-features="list"]')!;
    expect(list.textContent).toContain("Redeem on a US account");
    expect(price.compareDocumentPosition(buttons) & 4).toBe(4);
    expect(buttons.compareDocumentPosition(list) & 4).toBe(4);
    expect(populated.querySelectorAll('[data-product-features="list"]')).toHaveLength(1);
    expect((await render([])).querySelector('[data-product-features="list"]')).toBeNull();
  });

  it("keeps the description in the buy box when the setting says so, as one panel without a tab bar", async () => {
    const product = {
      id: "prod_1", slug: "tunic", name: "Cotton tunic", price: 300,
      description: "<p>Soft cotton for everyday wear.</p>",
    } as Product;
    const doc = html(await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: [], options: [], details: true, look: classic({ cta: "stack" }) },
      request: request("tunic"),
    }));
    const details = doc.querySelector("[data-product-summary] .buy-box-body #product-details")!;
    expect(details.textContent).toContain("Soft cotton for everyday wear.");
    // One panel needs no tab bar; its heading names it.
    expect(details.querySelector("[role=tablist]")).toBeNull();
    expect(details.querySelector("h2")?.textContent).toBe("Description");
  });

  it("shows the tab bar only when the description has company", async () => {
    const product = {
      id: "prod_1", slug: "tunic", name: "Cotton tunic", price: 300,
      description: "<p>Soft cotton.</p>",
      additionalInfo: [{ id: "fabric", title: "Fabric & care", content: "<p>Machine wash cold.</p>" }],
    } as Product;
    const doc = html(await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: [], options: [], details: true },
      request: request("tunic"),
    }));
    expect([...doc.querySelectorAll("[role=tab]")].map((tab) => tab.textContent?.trim())).toEqual(["Description", "Fabric & care"]);
  });

  it("puts the buy buttons in their visual order, Add to cart first, so Tab follows the eye", async () => {
    const product = { id: "prod_1", slug: "sample", name: "Sample", price: 300 } as Product;
    for (const look of [classic(), classic({ cta: "stack" }), STOREFRONT_MARKETPLACE_BUY_BOX_LOOK]) {
      const doc = html(await container.renderToString(ProductSummary, { props: { product, category: null, variants, options, details: false, look }, request: request("sample") }));
      const buttons = [...doc.querySelectorAll(".buy-box-ctas button")];
      expect(buttons.map((button) => button.getAttribute("data-action"))).toEqual(["add-to-cart", "buy-now"]);
      expect(buttons[0]!.compareDocumentPosition(buttons[1]!) & 4).toBe(4);
      expect(doc.querySelector("#quantity")?.getAttribute("form")).toBe("product-buy-form");
      expect(doc.querySelector("[data-action=buy-now]")?.getAttribute("form")).toBe("product-buy-form");
    }
    expect(html(await container.renderToString(ProductSummary, { props: { product, category: null, variants, options, details: false, look: classic({ cta: "stack" }) }, request: request("sample") }))
      .querySelector("[data-product-summary]")?.getAttribute("data-cta-layout")).toBe("stack");
  });

  it("says a product paid only online can't be bought on a cash-only store, with both buttons off", async () => {
    const product = { id: "prod_1", slug: "game-key", name: "Game key", price: 300 } as Product;
    const digital = variants.map((variant) => ({ ...variant, fulfillmentKind: "digital" as const }));
    const render = async (onlinePaymentUnavailable: boolean) => html(await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: digital, options, details: false, onlinePaymentUnavailable },
      request: request("game-key"),
    }));
    const blocked = await render(true);
    const note = blocked.querySelector("#product-online-payment-unavailable");
    expect(note?.textContent).toBe("This item can only be paid for online, and this store doesn't take online payments yet.");
    // The product controller keeps any purchase-blocking note's buttons off.
    expect(note?.hasAttribute("data-purchase-blocked")).toBe(true);
    expect((blocked.querySelector("[data-action=add-to-cart]") as HTMLButtonElement).disabled).toBe(true);
    expect((blocked.querySelector("[data-action=buy-now]") as HTMLButtonElement).disabled).toBe(true);
    // The note comes before the buttons it explains.
    expect(note!.compareDocumentPosition(blocked.querySelector(".buy-box-ctas")!) & 4).toBe(4);

    const buyable = await render(false);
    expect(buyable.querySelector("[data-purchase-blocked]")).toBeNull();
    expect((buyable.querySelector("[data-action=add-to-cart]") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a price of 24px/700 and no look-specific type sizes", async () => {
    const product = { id: "prod_1", slug: "sample", name: "Sample", price: 300 } as Product;
    const markup = await container.renderToString(ProductSummary, { props: { product, category: null, variants, options, details: false }, request: request("sample") });
    const price = html(markup).querySelector(".product-price")!;
    expect(price.className).toContain("text-2xl");
    expect(price.className).toContain("font-bold");
    expect(markup).not.toContain("--bb-title");
    expect(markup).not.toContain("data-buy-box-look");
  });

  it("groups arbitrary merchant options in panels without changing purchase controls", async () => {
    const product = { id: "prod_1", slug: "sample", name: "Sample", price: 300 } as Product;
    const doc = html(await container.renderToString(ProductSummary, {
      props: { product, category: null, variants, options, details: false, look: classic({ cta: "stack" }) },
      request: request("sample"),
    }));

    const panels = doc.querySelector(".variant-option-panels");
    expect([...panels!.children].map((panel) => panel.querySelector("legend")?.textContent)).toEqual(["Model", "Color"]);
    expect(panels?.querySelectorAll(".variant-option-btn")).toHaveLength(20);
    expect(panels?.querySelectorAll(".variant-option-values[data-option-overflow]")).toHaveLength(2);
    expect(doc.querySelectorAll(".buy-box-ctas button")).toHaveLength(2);
    expect(doc.querySelector("#product-variant-noscript")?.getAttribute("form")).toBe("product-buy-form");

    const fewOptions = options.map((option) => ({ ...option, values: option.values.slice(0, 3) }));
    const fewDoc = html(await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: variants.filter((variant) => variant.selectedOptions.every((choice) => Number(choice.optionValueId.slice(1)) < 3)), options: fewOptions, details: false },
      request: request("sample"),
    }));
    expect(fewDoc.querySelectorAll(".variant-option-btn")).toHaveLength(6);
    expect(fewDoc.querySelector(".variant-option-values[data-option-overflow]")).toBeNull();
  });

  it("keeps exact SKU selection, prices and availability in a compact 100-SKU payload", async () => {
    const product = { id: "prod_1", slug: "sample", name: "Sample", price: 300, discountType: null, discountPercentage: null, discountAmount: null } as Product;
    const doc = html(await container.renderToString(ProductSummary, {
      props: { product, category: null, variants, options, details: false, currencyCode: "BDT", currencyDecimalPlaces: 2 },
      request: request("sample"),
    }));
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
    const doc = html(await container.renderToString(ProductSummary, {
      props: { product, category: null, variants, options, details: false, look: STOREFRONT_MARKETPLACE_BUY_BOX_LOOK },
      request: request("sample"),
    }));
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
    // A price on each value, because the values are priced differently.
    const largeModel = doc.querySelector('[data-option-definition-id="model"][data-option-value-id="m1"].variant-option-btn');
    expect(largeModel?.querySelector("[data-option-price]")?.textContent).toContain("310");
    expect(largeModel?.getAttribute("aria-label")).toContain("310");
    const soldOutColor = doc.querySelector('[data-option-definition-id="color"][data-option-value-id="c1"].variant-option-btn');
    expect(soldOutColor?.querySelector("[data-option-price]")?.hasAttribute("hidden")).toBe(true);

    // Values priced the same repeat nothing.
    const flatDoc = html(await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: variants.map((variant) => ({ ...variant, price: 300, discountType: null })), options, details: false, look: STOREFRONT_MARKETPLACE_BUY_BOX_LOOK },
      request: request("sample"),
    }));
    expect(flatDoc.querySelectorAll("[data-option-price]:not([hidden])")).toHaveLength(0);

    const withoutFacts = { ...product, brand: null, attributes: [] };
    const emptyHtml = await container.renderToString(ProductSummary, {
      props: { product: withoutFacts, category: null, variants: [], options: [], details: false, look: STOREFRONT_MARKETPLACE_BUY_BOX_LOOK },
      request: request("sample"),
    });
    expect(emptyHtml).not.toContain("data-product-compact-facts");

    const otherHtml = await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: [], options: [], details: false, look: classic() },
      request: request("sample"),
    });
    expect(otherHtml).not.toContain("data-product-compact-facts");
  });

  it("speaks the store's language in the stock line and uses one word for sold out", async () => {
    const product = { id: "prod_1", slug: "sample", name: "Sample", price: 300 } as Product;
    const inStock = html(await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: [variants[0]!], options: [], details: false, stockWords: { inStock: "স্টকে আছে", lowStock: "স্টক কম" } },
      request: request("sample"),
    }));
    expect(inStock.querySelector("#product-stock-text")?.textContent).toBe("স্টকে আছে");
    expect(inStock.querySelector("#product-actions")?.getAttribute("data-stock-in-text")).toBe("স্টকে আছে");
    const soldOut = html(await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: [{ ...variants[1]! }], options: [], details: false },
      request: request("sample"),
    }));
    // The badge and the button say the same thing.
    expect(soldOut.querySelector("#product-stock-text")?.textContent).toBe("Sold out");
    expect(soldOut.querySelector('[data-action="add-to-cart"]')?.textContent?.trim()).toBe("Sold out");
  });

  it("gives a sold-out product a next step instead of a quantity stepper", async () => {
    const product = { id: "prod_1", slug: "sample", name: "Sample", price: 300 } as Product;
    const doc = html(await container.renderToString(ProductSummary, {
      props: { product, category: { id: "cat_1", name: "Phones", slug: "phones" }, variants: [{ ...variants[1]! }], options: [], details: false },
      request: request("sample"),
    }));
    expect(doc.querySelector("label[for=quantity]")?.parentElement?.hasAttribute("hidden")).toBe(true);
    const soldOut = doc.querySelector("[data-product-sold-out]")!;
    expect(soldOut.querySelector("a")?.getAttribute("href")).toBe("/categories/phones");
    // A product that can be bought has neither.
    const live = html(await container.renderToString(ProductSummary, {
      props: { product, category: null, variants: [variants[0]!], options: [], details: false },
      request: request("sample"),
    }));
    expect(live.querySelector("[data-product-sold-out]")).toBeNull();
    expect(live.querySelector("label[for=quantity]")?.parentElement?.hasAttribute("hidden")).toBe(false);
  });
});
