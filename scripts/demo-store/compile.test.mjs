import { describe, expect, it } from "vitest";

import { compileDemoStoreAdminCommands, stableDraftId } from "./compile.mjs";
import { demoStoreManifest } from "./manifest.mjs";

function findCommand(compiled, logicalKey) {
  const result = compiled.commands.find((item) => item.logicalKey === logicalKey);
  if (!result) throw new Error(`Missing command ${logicalKey}`);
  return result;
}

function matrixFor(compiled, slug) {
  const create = findCommand(compiled, `product:${slug}:base`);
  return create.body.optionMatrix ?? findCommand(compiled, `product:${slug}:matrix`).body;
}

describe("demo-store admin command compiler", () => {
  it("is deterministic, network-free, and compiles the complete manifest", () => {
    const first = compileDemoStoreAdminCommands(demoStoreManifest);
    const second = compileDemoStoreAdminCommands(demoStoreManifest);

    expect(first).toEqual(second);
    expect(first.writesEnabled).toBe(false);
    expect(first.summary.byPhase.vocabulary).toBe(1);
    expect(first.summary.byPhase.categories).toBe(5);
    expect(first.summary.byPhase.collections).toBe(5);
    expect(first.summary.byPhase.presentation).toBe(2);
    expect(first.retainedResources).toHaveLength(2);
    expect(new Set(first.commands.map((item) => item.id)).size).toBe(first.commands.length);
  });

  it("creates only a missing exact Brand vocabulary definition and blocks unsafe unversioned drift", () => {
    const missing = compileDemoStoreAdminCommands(demoStoreManifest);
    expect(findCommand(missing, "attribute:brand")).toMatchObject({
      phase: "vocabulary",
      method: "POST",
      path: "/api/v1/admin/attributes",
      body: { name: "Brand", slug: "brand", filterable: true, options: [] },
    });

    const matching = compileDemoStoreAdminCommands(demoStoreManifest, {
      current: { attributes: [{ id: "attr_brand", name: "Brand", slug: "brand", filterable: true }] },
    });
    expect(matching.commands.some((command) => command.logicalKey === "attribute:brand")).toBe(false);

    expect(() => compileDemoStoreAdminCommands(demoStoreManifest, {
      current: { attributes: [{ id: "attr_brand", name: "Brand", slug: "brand", filterable: false }] },
    })).toThrow(/unversioned attribute updates remain blocked/);
  });

  it("uses stable draft identities, exact SKU image references, omitted combinations, and null auto-barcodes", () => {
    const compiled = compileDemoStoreAdminCommands(demoStoreManifest);
    const vale = matrixFor(compiled, "vale-everyday-runners");
    const rove = matrixFor(compiled, "rove-packable-flats");

    expect(vale.options[0].id).toMatch(/^draft_option_[a-f0-9]{20}$/);
    expect(vale.options[0].values[0].id).toMatch(/^draft_value_[a-f0-9]{20}$/);
    expect(vale.variants[0].id).toMatch(/^draft_variant_[a-f0-9]{20}$/);
    expect(vale.variants.every((variant) => variant.barcode === null && variant.barcodeType === null)).toBe(true);
    expect(vale.variants.filter((variant) => variant.selectedOptionValueIds.length === 2)).toHaveLength(6);

    const chalkImages = vale.variants
      .filter((variant) => variant.sku.includes("CHALK"))
      .map((variant) => variant.imageId);
    expect(new Set(chalkImages).size).toBe(1);
    expect(chalkImages[0]).toMatch(/^pmed_demo_[a-f0-9]{20}$/);
    expect(rove.variants.filter((variant) => variant.sku.includes("BLACK")).every((variant) => variant.imageId === null)).toBe(true);
  });

  it("keeps new prices and stock positive while preserving simple-SKU generated barcodes", () => {
    const compiled = compileDemoStoreAdminCommands(demoStoreManifest);
    const newProductCreates = compiled.commands.filter((item) =>
      item.phase === "products" && item.method === "POST",
    );
    const matrixVariants = newProductCreates.flatMap((item) => item.body.optionMatrix?.variants ?? []);
    const simpleCommands = compiled.commands.filter((item) => item.logicalKey.endsWith(":simple-sku"));

    expect(newProductCreates.every((item) => item.body.price > 0)).toBe(true);
    expect(matrixVariants.every((variant) => variant.price > 0 && Number.isInteger(variant.stock) && variant.stock >= 0)).toBe(true);
    expect(simpleCommands).toHaveLength(4);
    expect(simpleCommands.every((item) => item.body.price > 0 && item.body.stock > 0)).toBe(true);
    expect(simpleCommands.every((item) => !("barcode" in item.body) && item.preconditions.preserveGeneratedBarcode)).toBe(true);
    expect(simpleCommands.every((item) => item.pathBindings.defaultVariantId)).toBe(true);
  });

  it("compiles retained products as guarded preservation updates", () => {
    const compiled = compileDemoStoreAdminCommands(demoStoreManifest);
    for (const slug of ["rider-court-trainers", "halo-arc-table-lamp"]) {
      const base = findCommand(compiled, `product:${slug}:base`);
      expect(base.method).toBe("PUT");
      expect(base.preservation).toMatchObject({
        preserveSkuIds: true,
        preserveOptionValueIds: true,
        preserveMediaAssociationIds: false,
        preserveSkuImageSemantics: true,
        preserveInventoryLedger: true,
        preserveReservations: true,
      });
      expect(findCommand(compiled, `product:${slug}:matrix`).preservation).toMatchObject({
        preserveSkuIds: true,
        preserveInventoryLedger: true,
        preserveReservations: true,
        noStockReset: true,
      });
      expect(base.body.isActive).toEqual({ $ref: `current-product:${slug}`, field: "isActive" });
      expect(base.body.acknowledgedSkuImageRemovalIds).toEqual({
        $ref: `current-product:${slug}`,
        field: "removedSkuImageIds",
      });
    }
    const haloMatrix = findCommand(compiled, "product:halo-arc-table-lamp:matrix");
    expect(haloMatrix.body.variants.every((variant) => variant.imageId === null)).toBe(true);
  });

  it("adopts operational SKU authority for existing matrices and seeds simple stock only with resume provenance", () => {
    const optioned = demoStoreManifest.products.find((product) => product.slug === "vale-everyday-runners");
    const simple = demoStoreManifest.products.find((product) => product.slug === "noor-ceramic-vase");
    const current = {
      productDetails: [
        { id: "prod_vale", slug: optioned.slug, aggregateRevision: 7, isActive: true },
        { id: "prod_noor", slug: simple.slug, aggregateRevision: 3, isActive: true },
      ],
    };
    const first = compileDemoStoreAdminCommands(demoStoreManifest, { current });
    const matrix = findCommand(first, `${optioned.logicalKey}:matrix`);
    expect(matrix.body.variants[0]).toMatchObject({
      id: { $ref: optioned.variants[0].logicalKey.replace(/^/u, "current-variant:"), field: "id" },
      sku: { $ref: optioned.variants[0].logicalKey.replace(/^/u, "current-variant:"), field: "sku" },
      stock: { $ref: optioned.variants[0].logicalKey.replace(/^/u, "current-variant:"), field: "stock" },
      barcode: { $ref: optioned.variants[0].logicalKey.replace(/^/u, "current-variant:"), field: "barcode" },
    });
    expect(first.commands.find((item) => item.logicalKey === `${simple.logicalKey}:simple-sku`)).toBeUndefined();

    current.resumeSimpleSlugs = [simple.slug];
    const resumed = compileDemoStoreAdminCommands(demoStoreManifest, { current });
    expect(findCommand(resumed, `${simple.logicalKey}:simple-sku`).body.sku).toEqual({
      $ref: `current-variant:${simple.variants[0].logicalKey}`,
      field: "sku",
    });
  });

  it("compiles sections, collection membership, heroes, and revision preconditions", () => {
    const current = {
      categories: [{ id: "cat_footwear", slug: "footwear", revision: 7, status: "published" }],
      collections: [{ id: "col_new", name: "New & Noteworthy", version: 3 }],
      heroes: [{ id: "hero_desktop", type: "desktop", revision: 4 }],
    };
    const compiled = compileDemoStoreAdminCommands(demoStoreManifest, { current });
    const footwear = findCommand(compiled, "category:footwear");
    const newCollection = findCommand(compiled, "collection:new-noteworthy");
    const desktopHero = findCommand(compiled, "hero-slider:desktop");
    const rider = findCommand(compiled, "product:rider-court-trainers:base");

    expect(footwear.preconditions.expectedRevision).toBe(7);
    expect(newCollection.preconditions.expectedVersion).toBe(3);
    expect(newCollection.body.config.productIds).toHaveLength(12);
    expect(newCollection.body.config.showOnHomepage).toBe(true);
    expect(newCollection.body.config.productIds.every((reference) => reference.$ref.endsWith(":base"))).toBe(true);
    expect(findCommand(compiled, "collection:weekend-ready").body.config.productIds).toHaveLength(8);
    expect(findCommand(compiled, "collection:weekend-ready").body.config.showOnHomepage).toBe(false);
    expect(findCommand(compiled, "collection:offers-worth-opening").body.config.productIds).toHaveLength(12);
    expect(desktopHero.body.expectedRevision).toBe(4);
    expect(desktopHero.body.images).toHaveLength(3);
    expect(desktopHero.body.images.every((slide) => slide.url.$ref.endsWith(":desktop"))).toBe(true);
    expect(newCollection.body.isActive).toBe(false);
    expect(desktopHero.body.isActive).toBe(false);
    expect(rider.body.additionalInfo).toHaveLength(3);
    expect(rider.body.additionalInfo.every((section) => section.id.$ref.startsWith("current-section:"))).toBe(true);
  });

  it("fails closed on retained identity conflicts", () => {
    expect(() => compileDemoStoreAdminCommands(demoStoreManifest, {
      current: {
        productDetails: [{
          id: "prod_wrong",
          slug: "rider-court-trainers",
          aggregateRevision: 2,
        }],
      },
    })).toThrow(/Retained product rider-court-trainers resolved to prod_wrong/);
  });

  it("keeps stable ID generation independent of process order", () => {
    expect(stableDraftId("draft_option", "product:one:Size")).toBe(
      stableDraftId("draft_option", "product:one:Size"),
    );
    expect(stableDraftId("draft_option", "product:one:Size")).not.toBe(
      stableDraftId("draft_option", "product:two:Size"),
    );
  });
});
