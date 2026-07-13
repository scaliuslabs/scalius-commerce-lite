import { describe, expect, it, vi } from "vitest";
import { ApplyHttpError } from "./demo-store/apply-client.mjs";
import {
  buildProductCommands,
  buildSimpleStockInitializationCommand,
} from "./demo-store/apply-commands.mjs";
import { executeIdempotentCommand } from "./demo-store/apply-executor.mjs";
import {
  assertStagedAssetReadiness,
  manifestReadinessFingerprint,
  validateStagedAssetReadiness,
} from "./demo-store/apply-readiness.mjs";
import { demoStoreManifest } from "./demo-store/manifest.mjs";
import { runRevisionSafeApply } from "./demo-store/run-apply.mjs";

function readinessReport() {
  const media = [
    ...demoStoreManifest.categories.flatMap((category) => category.media),
    ...demoStoreManifest.products.flatMap((product) => product.media),
    ...demoStoreManifest.heroes.flatMap((hero) => hero.media),
  ];
  return {
    schemaVersion: 1,
    status: "complete",
    verifiedAt: "2026-07-13T03:00:00.000Z",
    manifestFingerprint: manifestReadinessFingerprint(demoStoreManifest),
    assets: media.map((item, index) => ({
      logicalKey: item.logicalKey,
      mediaId: `media_demo_${String(index).padStart(4, "0")}`,
      status: "ready",
      kind: item.kind ?? "image",
      sha256: index.toString(16).padStart(64, "0"),
      url: `https://media.example.test/demo-${index}.webp`,
      filename: `demo-${index}.${item.kind === "video" ? "mp4" : "webp"}`,
      size: 200_000 + index,
      createdAt: "2026-07-13T02:00:00.000Z",
      width: item.kind === "video" ? 1920 : 1600,
      height: item.kind === "video" ? 1080 : 1600,
    })),
    presentation: {},
  };
}

function detail(product, readiness, id = product.retainedProductId ?? `prod_${product.slug}`) {
  const options = product.options.map((axis, position) => ({
    id: `popt_${product.slug}_${position}`,
    name: axis.name,
    position,
    standardMapping: axis.mapping,
    values: axis.values.map((value, valuePosition) => ({ id: `pval_${product.slug}_${position}_${valuePosition}`, value, position: valuePosition })),
  }));
  const variants = product.variants.map((variant, index) => ({
    id: `var_${product.slug}_${index}`,
    selectedOptions: variant.optionValues.map((value, position) => ({ name: options[position].name, value, position, optionDefinitionId: options[position].id, optionValueId: options[position].values.find((item) => item.value === value).id })),
    optionCombinationKey: variant.optionValues.map((value, position) => options[position].values.find((item) => item.value === value).id).join("|"),
    sku: variant.sku,
    price: variant.price,
    stock: variant.inventory.mode === "preserve" ? 12 - index : variant.inventory.onHand,
    reservedStock: 0,
    stockVersion: 2,
    trackInventory: true,
    weight: null,
    barcode: `AUTO-${product.slug}-${index}`,
    barcodeType: "code128",
    imageId: null,
    isDefault: product.options.length === 0,
    deletedAt: null,
  }));
  return {
    id, slug: product.slug, name: product.name, price: product.price,
    description: product.descriptionHtml, categoryId: `cat_${product.categorySlug}`,
    isActive: true, aggregateRevision: 4, options, variants,
    media: product.media.filter((item) => item.role !== "poster").map((item, index) => ({ id: `pmed_${product.slug}_${index}`, mediaId: readiness.assets.get(item.logicalKey).mediaId, status: "ready" })),
    additionalInfo: product.additionalSections.map((item, index) => ({ id: `prc_${product.slug}_${index}`, title: item.title, content: item.html, sortOrder: index })),
    attributes: [{ attributeId: "attr_brand", value: product.brand }],
    freeDelivery: product.freeDelivery,
    productCondition: "new",
  };
}

function completeSnapshot(report) {
  const readiness = assertStagedAssetReadiness(demoStoreManifest, report);
  const categories = demoStoreManifest.categories.map((category) => ({ id: `cat_${category.slug}`, slug: category.slug, name: category.name, description: category.description, status: "published", revision: 3 }));
  const productDetails = demoStoreManifest.products.map((product) => detail(product, readiness));
  return {
    capturedAt: "2026-07-13T03:00:00.000Z",
    categories,
    products: productDetails.map((product) => ({ id: product.id, slug: product.slug })),
    productDetails,
    media: report.assets,
    attributes: [{ id: "attr_brand", slug: "brand", name: "Brand", filterable: true }],
    collections: demoStoreManifest.collections.map((collection, index) => ({ id: `col_${index}`, name: collection.name, version: 2, presentation: collection.presentation, isActive: false })),
    presentation: {
      general: {}, theme: { colors: {}, revision: 2 },
      heroes: ["desktop", "mobile"].map((type) => ({ id: `slider_${type}`, type, revision: 2, images: [], isActive: false })),
    },
  };
}

describe("staged asset apply gate", () => {
  it("requires exact complete media coverage and a matching manifest fingerprint", () => {
    const report = readinessReport();
    expect(validateStagedAssetReadiness(demoStoreManifest, report)).toMatchObject({ ok: true });
    report.assets.pop();
    report.manifestFingerprint = "0".repeat(64);
    const result = validateStagedAssetReadiness(demoStoreManifest, report);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("fingerprint does not match"),
      expect.stringContaining("missing staged asset"),
    ]));
  });
});

describe("revision-safe product commands", () => {
  it("never submits retained Rider option or stock mutations", () => {
    const report = readinessReport();
    const readiness = assertStagedAssetReadiness(demoStoreManifest, report);
    const rider = demoStoreManifest.products.find((product) => product.slug === "rider-court-trainers");
    const current = detail(rider, readiness);
    const commands = buildProductCommands(rider, { id: rider.retainedProductId, slug: rider.slug }, current, {
      readiness, categoryId: "cat_footwear", brandAttributeId: "attr_brand",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0].path).toBe(`/api/v1/admin/products/${rider.retainedProductId}`);
    expect(commands[0].body).not.toHaveProperty("optionMatrix");
    expect(JSON.stringify(commands[0].body)).not.toContain("stock");
    expect(commands[0].body.isActive).toBe(true);
  });

  it("preserves existing SKU stock, barcode, and identity in a non-retained matrix", () => {
    const report = readinessReport();
    const readiness = assertStagedAssetReadiness(demoStoreManifest, report);
    const product = demoStoreManifest.products.find((item) => item.slug === "vale-everyday-runners");
    const current = detail(product, readiness);
    current.variants[0].stock = 7;
    const commands = buildProductCommands(product, { id: current.id, slug: product.slug }, current, {
      readiness, categoryId: "cat_footwear", brandAttributeId: "attr_brand",
    });
    const matrix = commands.find((command) => command.phase === "product-options").body;
    expect(matrix.variants[0]).toMatchObject({ id: current.variants[0].id, stock: 7, barcode: current.variants[0].barcode });
    expect(matrix.expectedAggregateRevision).toBe("REFETCH_AFTER_BASE");
  });

  it("builds simple stock initialization from the server default SKU and barcode", () => {
    const report = readinessReport();
    const readiness = assertStagedAssetReadiness(demoStoreManifest, report);
    const product = demoStoreManifest.products.find((item) => item.slug === "noor-ceramic-vase");
    const current = detail(product, readiness);
    current.variants[0].stock = 0;
    const command = buildSimpleStockInitializationCommand(product, current);
    expect(command.body).toMatchObject({ stock: 24, barcode: current.variants[0].barcode, expectedAggregateRevision: 4 });
  });
});

describe("idempotent command execution", () => {
  it("adopts a verified create after an ambiguous response without retrying", async () => {
    const client = { send: vi.fn().mockRejectedValue(new Error("connection ended")) };
    const resolveCurrent = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "cat_1", slug: "footwear" });
    const outcome = await executeIdempotentCommand({ action: "create", logicalKey: "category:footwear" }, {
      client, resolveCurrent, matchesDesired: async (_command, current) => current.slug === "footwear",
    });
    expect(outcome.status).toBe("adopted_after_ambiguous_response");
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("reports stale revisions and provider conflicts without blind retry", async () => {
    const stale = await executeIdempotentCommand({ action: "update", logicalKey: "category:footwear", expectedRevision: 2 }, {
      client: { send: vi.fn() }, resolveCurrent: vi.fn().mockResolvedValue({ id: "cat_1", revision: 3 }), matchesDesired: async () => false,
    });
    expect(stale).toMatchObject({ status: "conflict", code: "STALE_REVISION" });

    const client = { send: vi.fn().mockRejectedValue(new ApplyHttpError(409, "REVISION_CONFLICT")) };
    const conflict = await executeIdempotentCommand({ action: "update", logicalKey: "category:footwear", expectedRevision: 3 }, {
      client, resolveCurrent: vi.fn().mockResolvedValue({ id: "cat_1", revision: 3 }), matchesDesired: async () => false,
    });
    expect(conflict).toMatchObject({ status: "conflict", code: "REVISION_CONFLICT" });
    expect(client.send).toHaveBeenCalledTimes(1);
  });
});

describe("apply orchestration", () => {
  it("blocks before reading or writing when staged readiness is incomplete", async () => {
    const report = readinessReport();
    report.status = "partial";
    const readSnapshot = vi.fn();
    const executePhase = vi.fn();
    await expect(runRevisionSafeApply({
      manifest: demoStoreManifest,
      readinessReport: report,
      authorization: { confirmed: true, manifestFingerprint: manifestReadinessFingerprint(demoStoreManifest) },
      readSnapshot,
      executePhase,
    })).rejects.toThrow("readiness is incomplete");
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(executePhase).not.toHaveBeenCalled();
  });

  it("orders revision-safe phases and excludes retained option mutations", async () => {
    const report = readinessReport();
    const snapshot = completeSnapshot(report);
    const seen = [];
    const executePhase = vi.fn(async (commands, { phase }) => {
      seen.push({ phase, commands });
      return { ok: true, outcomes: commands.map((command) => ({ logicalKey: command.logicalKey, status: "already_applied", resourceId: command.identity.id ?? null })) };
    });
    const result = await runRevisionSafeApply({
      manifest: demoStoreManifest,
      readinessReport: report,
      authorization: { confirmed: true, manifestFingerprint: manifestReadinessFingerprint(demoStoreManifest) },
      readSnapshot: vi.fn().mockResolvedValue(snapshot),
      executePhase,
      now: () => new Date("2026-07-13T03:01:00.000Z"),
    });
    expect(result.status).toBe("staged_complete");
    expect(seen.map((item) => item.phase)).toEqual(["categories", "products", "collections", "settings"]);
    expect(seen.flatMap((item) => item.commands).some((command) => command.logicalKey === "product:rider-court-trainers:options")).toBe(false);
    expect(seen.flatMap((item) => item.commands).some((command) => command.logicalKey === "product:halo-arc-table-lamp:options")).toBe(false);
  });
});

