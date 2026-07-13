import { afterEach, describe, expect, it, vi } from "vitest";
import { main, parseDemoStoreArgs } from "./demo-store.mjs";
import { DEMO_STORE_CONTRACT, demoStoreManifest } from "./demo-store/manifest.mjs";
import { buildDemoStorePlan } from "./demo-store/plan.mjs";
import { assertValidDemoStoreManifest, validateDemoStoreManifest } from "./demo-store/validate.mjs";

describe("demo store manifest", () => {
  it("proves the exact catalog and content contract", () => {
    expect(assertValidDemoStoreManifest()).toEqual({
      categories: 5,
      products: 50,
      skus: 177,
      optionedProducts: 46,
      simpleProducts: 4,
      productMediaSlots: 226,
      presentationMediaSlots: 11,
      mediaSlots: 237,
      productsWithTwoOrMoreSections: 19,
      additionalSections: 49,
      collections: 5,
      offers: 18,
      heroes: 3,
    });
    expect(DEMO_STORE_CONTRACT).toMatchObject({ categories: 5, products: 50, skus: 177 });
  });

  it("models the omitted Halo combination and partial exact-image fallbacks", () => {
    const halo = demoStoreManifest.products.find((product) => product.slug === "halo-arc-table-lamp");
    const rove = demoStoreManifest.products.find((product) => product.slug === "rove-packable-flats");

    expect(halo.variants.map((variant) => variant.optionValues)).toEqual([
      ["Matte", "EU"],
      ["Matte", "US"],
      ["Gloss", "EU"],
    ]);
    expect(halo.variantImageIntent).toEqual({
      mode: "combinations",
      exactCombinations: [["Matte", "EU"]],
    });
    expect(rove.variantImageIntent).toEqual({
      mode: "axis",
      axis: "Color",
      exactValues: ["Rose"],
    });
  });

  it("fails closed on duplicate identity, non-positive price, and broken media intent", () => {
    const manifest = structuredClone(demoStoreManifest);
    manifest.products[1].slug = manifest.products[0].slug;
    manifest.products[2].variants[0].price = 0;
    manifest.products[3].media[0].altText = manifest.products[4].media[0].altText;

    const result = validateDemoStoreManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("Product slugs must be unique"),
      expect.stringContaining("price must be positive"),
      expect.stringContaining("Media alt text must be unique"),
    ]));
  });

  it("ships finished buyer copy and distinct bounded SEO summaries", () => {
    for (const category of demoStoreManifest.categories) {
      expect(category.seo.description).not.toBe(category.description);
      expect(category.seo.description.length).toBeGreaterThanOrEqual(70);
      expect(category.seo.description.length).toBeLessThanOrEqual(200);
    }
    for (const product of demoStoreManifest.products) {
      const description = product.descriptionHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const buyerCopy = [
        description,
        product.seo.description,
        ...product.additionalSections.map((section) => section.html.replace(/<[^>]+>/g, " ")),
      ].join(" ");
      expect(buyerCopy).not.toMatch(/\b(?:pending|to be confirmed|will be confirmed|will be stated|final sourced|final product|final pack|unverified certification|not promised)\b/i);
      expect(product.seo.description).not.toBe(description);
      expect(product.seo.description.length).toBeGreaterThanOrEqual(70);
      expect(product.seo.description.length).toBeLessThanOrEqual(200);
    }
  });

  it("rejects unfinished sourcing notes from buyer-facing fields", () => {
    const manifest = structuredClone(demoStoreManifest);
    manifest.products[0].additionalSections[0].html = "<p>Exact sizing will be confirmed against the final sourced product.</p>";

    const result = validateDemoStoreManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Product rider-court-trainers section rider-court-trainers:section:fit-sizing contains unfinished sourcing or placeholder language",
    );
  });
});

describe("demo store plan command", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is write-free and prints the validated plan", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("Plan mode attempted network access");
    });
    vi.stubGlobal("fetch", fetchMock);
    const lines = [];

    await expect(main(["--plan"], { log: (line) => lines.push(line) })).resolves.toBe(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("5 categories · 50 products · 177 SKUs");
    expect(lines.join("\n")).toContain("Writes: disabled");
    expect(lines.join("\n")).toContain("Validation: passed");
  });

  it("builds stable resumable phase keys without enabling writes", () => {
    const first = buildDemoStorePlan();
    const second = buildDemoStorePlan();
    expect(first.writesEnabled).toBe(false);
    expect(first.phases).toEqual(second.phases);
    expect(new Set(first.phases.map((phase) => phase.resumeKey)).size).toBe(first.phases.length);
  });

  it("compiles the complete deterministic API intent without network access or writes", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("Compile mode attempted network access");
    });
    vi.stubGlobal("fetch", fetchMock);
    const lines = [];

    await expect(main(["--compile"], { log: (line) => lines.push(line) })).resolves.toBe(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("compiled admin intent");
    expect(lines.join("\n")).toContain("vocabulary 1");
    expect(lines.join("\n")).toContain("Writes: disabled");
    expect(lines.join("\n")).toContain("Execution: unavailable");
  });

  it("rejects implicit write mode and unknown flags", async () => {
    expect(parseDemoStoreArgs(["--plan", "--json"])).toEqual({ help: false, plan: true, compile: false, diff: false, json: true });
    expect(() => parseDemoStoreArgs(["--apply"])).toThrow("Unknown option");
    await expect(main([], { log: vi.fn() })).rejects.toThrow("Write mode is not implemented");
  });
});
