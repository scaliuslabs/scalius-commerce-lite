import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { assertRetainedProductAuthority, runDemoStoreApply, runRevisionSafeApply } from "./demo-store/run-apply.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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

function remoteReadinessReport() {
  const report = readinessReport();
  const expected = buildExpectedAssets(demoStoreManifest);
  const assetByKey = new Map(report.assets.map((asset) => [asset.logicalKey, asset]));
  const expectedByOwner = new Map();
  for (const asset of expected) {
    const rows = expectedByOwner.get(asset.owner) ?? [];
    rows.push(asset);
    expectedByOwner.set(asset.owner, rows);
  }
  report.assets = report.assets.map((asset) => {
    const intent = expected.find((candidate) => candidate.logicalKey === asset.logicalKey);
    const poster = intent.kind === "video"
      ? expectedByOwner.get(intent.owner).find((candidate) => candidate.role.startsWith("poster"))
      : null;
    return {
      ...asset,
      importAction: "uploaded",
      ...(poster ? {
        posterLogicalKey: poster.logicalKey,
        posterMediaId: assetByKey.get(poster.logicalKey).mediaId,
      } : {}),
    };
  });
  report.unversionedSettings = [];
  report.evidence = {
    productsMutated: false,
    publicationMutated: false,
    uploadOrder: "sequential",
    posterLinksVerified: report.assets.filter((asset) => asset.kind === "video").length,
  };
  return report;
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
  const productDetails = demoStoreManifest.products.map((product) => ({
    ...detail(product, readiness),
    isActive: Boolean(product.retainedProductId),
  }));
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

function remoteSnapshot(report) {
  const snapshot = completeSnapshot(report);
  snapshot.media = report.assets.map((asset) => ({
    id: asset.mediaId,
    status: "ready",
    kind: asset.kind,
    filename: asset.filename,
    url: asset.url,
    size: asset.size,
    width: asset.width,
    height: asset.height,
    posterMediaId: asset.posterMediaId ?? null,
  }));
  return snapshot;
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

  it("binds retained Rider with exact media acknowledgements and preserved SKU authority", () => {
    const report = readinessReport();
    const readiness = assertStagedAssetReadiness(demoStoreManifest, report);
    const snapshot = completeSnapshot(report);
    const rider = demoStoreManifest.products.find((product) => product.slug === "rider-court-trainers");
    const compiled = compileDemoStoreAdminCommands(demoStoreManifest, { current: snapshot });
    const commands = compiled.commands.filter((command) => command.logicalKey.startsWith(`${rider.logicalKey}:`));
    const binder = createApplyBinder({
      manifest: demoStoreManifest,
      readiness,
      snapshot,
      outputs: new Map([[`${rider.logicalKey}:base`, {
        id: rider.retainedProductId,
        aggregateRevision: 5,
      }]]),
    });
    const base = binder.bind(commands.find((command) => command.logicalKey.endsWith(":base")));
    const matrix = binder.bind(commands.find((command) => command.logicalKey.endsWith(":matrix")));
    const current = snapshot.productDetails.find((item) => item.slug === rider.slug);
    expect(commands).toHaveLength(2);
    expect(base.path).toBe(`/api/v1/admin/products/${rider.retainedProductId}`);
    expect(base.body).not.toHaveProperty("optionMatrix");
    expect(base.body.acknowledgedSkuImageRemovalIds).toEqual([]);
    expect(base.body.isActive).toBe(true);
    expect(base.body.media.map((item) => item.id)).toEqual(current.media.map((item) => item.id));
    expect(base.body.media.every((item) => typeof item.mediaId === "string" && item.mediaId.startsWith("media_demo_"))).toBe(true);
    expect(matrix.body.expectedAggregateRevision).toBe(5);
    expect(matrix.body.variants.map((variant) => variant.id)).toEqual(current.variants.map((variant) => variant.id));
    expect(matrix.body.variants.map((variant) => variant.stock)).toEqual(current.variants.map((variant) => variant.stock));
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

  it("refuses to overwrite a public demo resource before the quarantine lifecycle", async () => {
    const report = readinessReport();
    const snapshot = completeSnapshot(report);
    snapshot.productDetails.find((item) => item.slug === "vale-everyday-runners").isActive = true;
    const executeCommand = vi.fn();
    await expect(runRevisionSafeApply({
      manifest: demoStoreManifest,
      readinessReport: report,
      authorization: { confirmed: true, intentFingerprint: demoApplyIntentFingerprint(demoStoreManifest) },
      readSnapshot: vi.fn().mockResolvedValue(snapshot),
      executeCommand,
      now: () => new Date("2026-07-13T03:01:00.000Z"),
    })).rejects.toThrow(/to be quarantined before apply/);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("binds the compiler plan in staged order and excludes activation and publication", async () => {
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
    expect(seen.some((item) => item.command.logicalKey === "product:rider-court-trainers:matrix")).toBe(true);
    expect(seen.some((item) => item.command.logicalKey === "product:halo-arc-table-lamp:matrix")).toBe(true);
    expect(seen.some((item) => item.command.phase === "activation" || item.command.phase === "publication")).toBe(false);
    expect(seen.every((item) => !JSON.stringify(item.command).includes('"$ref"'))).toBe(true);
  });
});

describe("guarded apply exposure", () => {
  it("rechecks permissions and authority after confirmation before delegating to the lifecycle", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "scalius-apply-runner-"));
    temporaryDirectories.push(directory);
    const report = remoteReadinessReport();
    const snapshot = remoteSnapshot(report);
    const permissions = [
      "attributes.create", "categories.create", "categories.edit", "collections.create",
      "collections.edit", "products.create", "products.edit", "settings.header.edit",
    ];
    const readClient = { get: vi.fn().mockResolvedValue({ isSuperAdmin: false, permissions }) };
    const lifecycleRunner = vi.fn().mockResolvedValue({
      phases: [{ name: "complete", state: "complete", outcomes: [] }],
      authorities: new Map(),
    });
    const desiredStateVerifier = vi.fn().mockResolvedValue({
      status: "verified",
      verifiedCommands: 117,
      diff: { summary: { conflicts: 0 } },
    });
    const intentFingerprint = demoApplyIntentFingerprint(demoStoreManifest);
    const closeSession = vi.fn().mockResolvedValue({ status: "closed", statusCode: 200 });
    const result = await runDemoStoreApply({
      adminOrigin: "https://dashboard.example.test",
      credentials: { email: "admin@example.test", password: "private" },
      readinessReport: report,
      evidenceDir: directory,
      resumeFile: path.join(directory, "resume.jsonl"),
      manifest: demoStoreManifest,
      confirmApply: vi.fn().mockResolvedValue({ confirmed: true, resetConfirmed: true, intentFingerprint }),
      now: () => new Date("2026-07-13T03:01:00.000Z"),
      openSession: vi.fn().mockResolvedValue({ cookieHeader: "session=private" }),
      closeSession,
      readClientFactory: vi.fn().mockReturnValue(readClient),
      applyClientFactory: vi.fn().mockReturnValue({}),
      snapshotReader: vi.fn().mockResolvedValue(snapshot),
      evidenceWriter: vi.fn().mockResolvedValue({ runId: "run", runDir: directory, files: {} }),
      lifecycleRunner,
      desiredStateVerifier,
      fetchImpl: vi.fn(),
    });
    expect(readClient.get).toHaveBeenCalledTimes(2);
    expect(lifecycleRunner).toHaveBeenCalledTimes(1);
    expect(desiredStateVerifier).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "verified", sessionCleanup: { status: "closed" } });
    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  it("does not create evidence or invoke the lifecycle when reset confirmation is incomplete", async () => {
    const report = remoteReadinessReport();
    const snapshot = remoteSnapshot(report);
    const evidenceWriter = vi.fn();
    const lifecycleRunner = vi.fn();
    const closeSession = vi.fn().mockResolvedValue({ status: "closed", statusCode: 200 });
    await expect(runDemoStoreApply({
      adminOrigin: "https://dashboard.example.test",
      credentials: { email: "admin@example.test", password: "private" },
      readinessReport: report,
      evidenceDir: "/unused",
      resumeFile: "/unused",
      manifest: demoStoreManifest,
      confirmApply: vi.fn().mockResolvedValue({ confirmed: true, resetConfirmed: false, intentFingerprint: demoApplyIntentFingerprint(demoStoreManifest) }),
      now: () => new Date("2026-07-13T03:01:00.000Z"),
      openSession: vi.fn().mockResolvedValue({ cookieHeader: "session=private" }),
      closeSession,
      readClientFactory: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue({ isSuperAdmin: true, permissions: [] }) }),
      snapshotReader: vi.fn().mockResolvedValue(snapshot),
      evidenceWriter,
      lifecycleRunner,
      fetchImpl: vi.fn(),
    })).rejects.toThrow("did not authorize");
    expect(evidenceWriter).not.toHaveBeenCalled();
    expect(lifecycleRunner).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledTimes(1);
  });
});
