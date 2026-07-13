import { describe, expect, it, vi } from "vitest";
import { ApplyHttpError } from "./demo-store/apply-client.mjs";
import { createApplyBinder } from "./demo-store/apply-bind.mjs";
import { executeIdempotentCommand } from "./demo-store/apply-executor.mjs";
import {
  assertStagedAssetReadiness,
  manifestReadinessFingerprint,
  validateStagedAssetReadiness,
} from "./demo-store/apply-readiness.mjs";
import { buildExpectedAssets } from "./demo-store/assets/expected-assets.mjs";
import { ASSET_PROFILES } from "./demo-store/assets/profiles.mjs";
import { demoApplyIntentFingerprint } from "./demo-store/apply/authorization.mjs";
import { compileDemoStoreAdminCommands } from "./demo-store/compile.mjs";
import { demoStoreManifest } from "./demo-store/manifest.mjs";
import { assertRetainedProductAuthority, runRevisionSafeApply } from "./demo-store/run-apply.mjs";

function readinessReport() {
  const media = buildExpectedAssets(demoStoreManifest);
  return {
    schemaVersion: 1,
    status: "complete",
    verifiedAt: "2026-07-13T03:00:00.000Z",
    manifestFingerprint: manifestReadinessFingerprint(demoStoreManifest),
    assets: media.map((item, index) => ({
      logicalKey: item.logicalKey,
      mediaId: `media_demo_${String(index).padStart(4, "0")}`,
      status: "ready",
      kind: item.kind,
      sha256: index.toString(16).padStart(64, "0"),
      url: `https://media.example.test/demo-${index}.webp`,
      filename: `demo-${index}.${item.kind === "video" ? "mp4" : "webp"}`,
      size: 200_000 + index,
      createdAt: "2026-07-13T02:00:00.000Z",
      width: item.kind === "video" ? 1920 : ASSET_PROFILES[item.profile].width,
      height: item.kind === "video" ? 1080 : ASSET_PROFILES[item.profile].height,
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

  it("fingerprints crop/profile intent and rejects wrong normalized presentation dimensions", () => {
    const changed = structuredClone(demoStoreManifest);
    changed.products[1].media.find((media) => media.slot === "P").intendedCrop = "cover";
    expect(manifestReadinessFingerprint(changed)).not.toBe(manifestReadinessFingerprint(demoStoreManifest));

    const report = readinessReport();
    const category = report.assets.find((asset) => asset.logicalKey === "category:footwear:image");
    category.height = 1600;
    expect(validateStagedAssetReadiness(demoStoreManifest, report).errors).toContain(
      "category:footwear:image dimensions do not match category",
    );
  });
});

describe("revision-safe product commands", () => {
  it("binds a missing Brand definition as a create-only vocabulary prerequisite", () => {
    const report = readinessReport();
    const readiness = assertStagedAssetReadiness(demoStoreManifest, report);
    const snapshot = completeSnapshot(report);
    snapshot.attributes = [];
    const compiled = compileDemoStoreAdminCommands(demoStoreManifest, { current: snapshot });
    const intent = compiled.commands.find((command) => command.logicalKey === "attribute:brand");
    const bound = createApplyBinder({ manifest: demoStoreManifest, readiness, snapshot }).bind(intent);
    expect(bound).toMatchObject({
      action: "create",
      path: "/api/v1/admin/attributes",
      identity: { slug: "brand" },
      desired: { name: "Brand", slug: "brand", filterable: true },
      body: { name: "Brand", slug: "brand", filterable: true, options: [] },
    });
  });

  it("binds retained Rider through the compiler without option or stock mutations", () => {
    const report = readinessReport();
    const readiness = assertStagedAssetReadiness(demoStoreManifest, report);
    const snapshot = completeSnapshot(report);
    const rider = demoStoreManifest.products.find((product) => product.slug === "rider-court-trainers");
    const compiled = compileDemoStoreAdminCommands(demoStoreManifest, { current: snapshot });
    const commands = compiled.commands.filter((command) => command.logicalKey.startsWith(`${rider.logicalKey}:`));
    const bound = createApplyBinder({ manifest: demoStoreManifest, readiness, snapshot }).bind(commands[0]);
    expect(commands).toHaveLength(1);
    expect(bound.path).toBe(`/api/v1/admin/products/${rider.retainedProductId}`);
    expect(bound.body).not.toHaveProperty("optionMatrix");
    expect(JSON.stringify(bound.body)).not.toContain("stock");
    expect(bound.body.isActive).toBe(true);
    expect(bound.body.media.map((item) => item.id)).toEqual(snapshot.productDetails.find((item) => item.slug === rider.slug).media.map((item) => item.id));
    expect(bound.body.media.every((item) => typeof item.mediaId === "string" && item.mediaId.startsWith("media_demo_"))).toBe(true);
  });

  it("binds existing matrices with current SKU stock, barcode, and identity", () => {
    const report = readinessReport();
    const readiness = assertStagedAssetReadiness(demoStoreManifest, report);
    const snapshot = completeSnapshot(report);
    const product = demoStoreManifest.products.find((item) => item.slug === "vale-everyday-runners");
    const current = snapshot.productDetails.find((item) => item.slug === product.slug);
    current.variants[0].stock = 7;
    const compiled = compileDemoStoreAdminCommands(demoStoreManifest, { current: snapshot });
    const intent = compiled.commands.find((command) => command.logicalKey === `${product.logicalKey}:matrix`);
    const matrix = createApplyBinder({
      manifest: demoStoreManifest,
      readiness,
      snapshot,
      outputs: new Map([[`${product.logicalKey}:base`, { id: current.id, aggregateRevision: 5 }]]),
    }).bind(intent).body;
    expect(matrix.variants[0]).toMatchObject({ id: current.variants[0].id, stock: 7, barcode: current.variants[0].barcode });
    expect(matrix.expectedAggregateRevision).toBe(5);
  });

  it("resumes simple stock only through the server default SKU and omits barcode fields", () => {
    const report = readinessReport();
    const readiness = assertStagedAssetReadiness(demoStoreManifest, report);
    const snapshot = completeSnapshot(report);
    const product = demoStoreManifest.products.find((item) => item.slug === "noor-ceramic-vase");
    const current = snapshot.productDetails.find((item) => item.slug === product.slug);
    current.variants[0].stock = 0;
    const compiled = compileDemoStoreAdminCommands(demoStoreManifest, { current: { ...snapshot, resumeSimpleSlugs: [product.slug] } });
    const intent = compiled.commands.find((command) => command.logicalKey === `${product.logicalKey}:simple-sku`);
    const command = createApplyBinder({
      manifest: demoStoreManifest,
      readiness,
      snapshot,
      outputs: new Map([[`${product.logicalKey}:base`, { id: current.id, aggregateRevision: 5 }]]),
    }).bind(intent);
    expect(command.path).toContain(current.variants[0].id);
    expect(command.body).toMatchObject({ stock: 24, sku: current.variants[0].sku, expectedAggregateRevision: 5 });
    expect(command.body).not.toHaveProperty("barcode");
    expect(command.body).not.toHaveProperty("barcodeType");
  });

  it("fails closed when a retained ready media association would be removed", () => {
    const report = readinessReport();
    const readiness = assertStagedAssetReadiness(demoStoreManifest, report);
    const snapshot = completeSnapshot(report);
    const rider = snapshot.productDetails.find((item) => item.slug === "rider-court-trainers");
    rider.media.push({ id: "pmed_unrepresented", mediaId: "media_unrepresented", status: "ready" });
    expect(() => assertRetainedProductAuthority(demoStoreManifest, snapshot, readiness)).toThrow(/Retained media would be removed/);
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
  it("authorizes the complete product intent rather than the media-only readiness fingerprint", async () => {
    const report = readinessReport();
    const changed = structuredClone(demoStoreManifest);
    changed.products[0].price += 1;
    const readSnapshot = vi.fn();
    await expect(runRevisionSafeApply({
      manifest: changed,
      readinessReport: { ...report, manifestFingerprint: manifestReadinessFingerprint(changed) },
      authorization: { confirmed: true, intentFingerprint: demoApplyIntentFingerprint(demoStoreManifest) },
      readSnapshot,
      executeCommand: vi.fn(),
    })).rejects.toThrow(/complete validated demo-store intent/);
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it("blocks before reading or writing when staged readiness is incomplete", async () => {
    const report = readinessReport();
    report.status = "partial";
    const readSnapshot = vi.fn();
    const executeCommand = vi.fn();
    await expect(runRevisionSafeApply({
      manifest: demoStoreManifest,
      readinessReport: report,
      authorization: { confirmed: true, intentFingerprint: demoApplyIntentFingerprint(demoStoreManifest) },
      readSnapshot,
      executeCommand,
    })).rejects.toThrow("readiness is incomplete");
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("refuses to reseed an existing simple SKU without completed-create provenance", async () => {
    const report = readinessReport();
    const snapshot = completeSnapshot(report);
    snapshot.productDetails.find((item) => item.slug === "noor-ceramic-vase").variants[0].stock = 0;
    const executeCommand = vi.fn();
    await expect(runRevisionSafeApply({
      manifest: demoStoreManifest,
      readinessReport: report,
      authorization: { confirmed: true, intentFingerprint: demoApplyIntentFingerprint(demoStoreManifest) },
      readSnapshot: vi.fn().mockResolvedValue(snapshot),
      executeCommand,
      now: () => new Date("2026-07-13T03:01:00.000Z"),
    })).rejects.toThrow(/Simple stock provenance is unknown/);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("binds the compiler plan in staged order and excludes activation, publication, and retained matrices", async () => {
    const report = readinessReport();
    const snapshot = completeSnapshot(report);
    const seen = [];
    const executeCommand = vi.fn(async (command, { phase }) => {
      seen.push({ phase, command });
      const current = command.identity.id
        ? snapshot.productDetails.find((item) => item.id === command.identity.id)
          ?? snapshot.categories.find((item) => item.id === command.identity.id)
          ?? snapshot.collections.find((item) => item.id === command.identity.id)
          ?? snapshot.presentation.heroes.find((item) => item.id === command.identity.id)
        : null;
      return {
        logicalKey: command.logicalKey,
        status: "already_applied",
        resourceId: current?.id ?? command.identity.id ?? null,
        authority: {
          id: current?.id ?? command.identity.id ?? `created_${command.logicalKey}`,
          aggregateRevision: (current?.aggregateRevision ?? 4) + 1,
          revision: current?.revision ?? 3,
          version: current?.version ?? 2,
        },
      };
    });
    const result = await runRevisionSafeApply({
      manifest: demoStoreManifest,
      readinessReport: report,
      authorization: { confirmed: true, intentFingerprint: demoApplyIntentFingerprint(demoStoreManifest) },
      readSnapshot: vi.fn().mockResolvedValue(snapshot),
      executeCommand,
      now: () => new Date("2026-07-13T03:01:00.000Z"),
    });
    expect(result.status).toBe("staged_complete");
    expect([...new Set(seen.map((item) => item.phase))]).toEqual(["categories", "products", "collections", "presentation"]);
    expect(result.excludedPhases).toEqual(["activation", "publication"]);
    expect(seen.some((item) => item.command.logicalKey === "product:rider-court-trainers:matrix")).toBe(false);
    expect(seen.some((item) => item.command.logicalKey === "product:halo-arc-table-lamp:matrix")).toBe(false);
    expect(seen.some((item) => item.command.phase === "activation" || item.command.phase === "publication")).toBe(false);
    expect(seen.every((item) => !JSON.stringify(item.command).includes('"$ref"'))).toBe(true);
  });
});
