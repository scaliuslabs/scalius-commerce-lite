import { describe, expect, it, vi } from "vitest";

import { compileDemoStoreAdminCommands } from "../compile.mjs";
import { demoStoreManifest } from "../manifest.mjs";
import {
  assertDemoApplyAuthorization,
  demoApplyIntentFingerprint,
} from "./authorization.mjs";
import { runDemoApplyLifecycle } from "./orchestrator.mjs";
import {
  buildDemoApplyLifecycle,
  DEMO_APPLY_PHASE_ORDER,
} from "./phase-model.mjs";
import {
  createResumeRecord,
  parseResumeJournal,
  restoreResumeState,
} from "./resume-journal.mjs";
import { createDemoLifecycleRuntime } from "./runtime.mjs";

function currentSnapshot() {
  const categories = demoStoreManifest.categories.map((category) => ({
    id: `cat_${category.slug}`,
    slug: category.slug,
    name: category.name,
    description: category.description,
    revision: 3,
    status: "draft",
  }));
  const retained = demoStoreManifest.products
    .filter((product) => product.retainedProductId)
    .map((product) => ({
      id: product.retainedProductId,
      slug: product.slug,
      aggregateRevision: 4,
      isActive: true,
    }));
  return {
    capturedAt: "2026-07-13T12:00:00.000Z",
    categories,
    productDetails: [
      ...retained,
      {
        id: "prod_vale_existing",
        slug: "vale-everyday-runners",
        aggregateRevision: 7,
        isActive: false,
      },
    ],
    collections: demoStoreManifest.collections.map((collection, index) => ({
      id: `col_${index}`,
      name: collection.name,
      version: 2,
      presentation: collection.presentation,
      isActive: index === 0,
    })),
    heroes: [
      { id: "slider_desktop", type: "desktop", revision: 4, isActive: true },
      { id: "slider_mobile", type: "mobile", revision: 3, isActive: false },
    ],
    presentation: {
      theme: { colors: {}, revision: 2 },
      heroes: [
        { id: "slider_desktop", type: "desktop", revision: 4, isActive: true },
        { id: "slider_mobile", type: "mobile", revision: 3, isActive: false },
      ],
    },
  };
}

function lifecycle(publicationIntent = {}) {
  const snapshot = currentSnapshot();
  const compiled = compileDemoStoreAdminCommands(demoStoreManifest, { current: snapshot });
  return buildDemoApplyLifecycle({ manifest: demoStoreManifest, snapshot, compiled, publicationIntent });
}

describe("complete apply authorization", () => {
  it("covers deep catalog, merchandising, and publication facts", () => {
    const intent = { theme: { colors: { "--primary": "#000000" } } };
    const base = demoApplyIntentFingerprint(demoStoreManifest, intent);
    for (const mutate of [
      (manifest) => { manifest.products[0].price += 1; },
      (manifest) => { manifest.products[0].descriptionHtml = manifest.products[0].descriptionHtml.replace("retro-inspired", "court-inspired"); },
      (manifest) => { manifest.products.find((product) => product.offer).offer.value += 1; },
      (manifest) => { manifest.collections[0].limit += 1; },
      (manifest) => { manifest.heroes[0].destination = "category:footwear"; },
    ]) {
      const changed = structuredClone(demoStoreManifest);
      mutate(changed);
      expect(demoApplyIntentFingerprint(changed, intent)).not.toBe(base);
    }
    expect(demoApplyIntentFingerprint(demoStoreManifest, {
      theme: { colors: { "--primary": "#ffffff" } },
    })).not.toBe(base);
    expect(() => assertDemoApplyAuthorization({
      authorization: { confirmed: true, intentFingerprint: "0".repeat(64) },
      manifest: demoStoreManifest,
      publicationIntent: intent,
    })).toThrow(/complete demo-store intent/);
  });
});

describe("safe lifecycle phase model", () => {
  it("models the full dependency order and resumes inactive existing products", () => {
    const plan = lifecycle();
    expect(plan.phases.map((phase) => phase.name)).toEqual(DEMO_APPLY_PHASE_ORDER);
    expect(plan.phases.find((phase) => phase.name === "stage_vocabulary").commands).toEqual([
      expect.objectContaining({ logicalKey: "attribute:brand", method: "POST" }),
    ]);
    const activate = plan.phases
      .find((phase) => phase.name === "activate_products")
      .commands.find((command) => command.logicalKey === "product:vale-everyday-runners:activate");
    expect(activate).toBeDefined();
    expect(activate.body.isActive).toBe(true);
    expect(activate.body.expectedAggregateRevision).toEqual({
      $ref: "product:vale-everyday-runners:matrix",
      field: "aggregateRevision",
    });
    expect(activate.body).not.toHaveProperty("optionMatrix");
    expect(plan.phases.find((phase) => phase.name === "activate_products").commands)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ logicalKey: "product:rider-court-trainers:activate" }),
      ]));
  });

  it("quarantines active collections and heroes before staging and reactivates with CAS", () => {
    const plan = lifecycle();
    const quarantine = plan.phases.find((phase) => phase.name === "quarantine").commands;
    expect(quarantine).toEqual(expect.arrayContaining([
      expect.objectContaining({
        logicalKey: "collection:new-noteworthy:quarantine",
        body: { expectedVersion: 2, isActive: false },
      }),
      expect.objectContaining({
        logicalKey: "hero-slider:desktop:quarantine",
        body: { expectedRevision: 4, isActive: false },
      }),
    ]));
    const stagedCollection = plan.phases.find((phase) => phase.name === "stage_collections")
      .commands.find((command) => command.logicalKey === "collection:new-noteworthy");
    expect(stagedCollection.body.isActive).toBe(false);
    expect(stagedCollection.body.expectedVersion).toEqual({
      $ref: "collection:new-noteworthy:quarantine",
      field: "version",
    });
    const collectionActivation = plan.phases.find((phase) => phase.name === "activate_collections")
      .commands.find((command) => command.logicalKey === "collection:new-noteworthy:activate");
    expect(collectionActivation.body).toEqual({
      expectedVersion: { $ref: "collection:new-noteworthy", field: "version" },
      isActive: true,
    });
    const heroActivation = plan.phases.find((phase) => phase.name === "activate_heroes")
      .commands.find((command) => command.logicalKey === "hero-slider:desktop:activate");
    expect(heroActivation.body).toEqual({
      expectedRevision: { $ref: "hero-slider:desktop", field: "revision" },
      isActive: true,
    });
  });

  it("publishes versioned theme but blocks unversioned navigation and promotions", () => {
    const plan = lifecycle({
      theme: { colors: { "--background": "#ffffff" } },
      navigation: { header: { navigation: [] } },
      promotions: [{ code: "DEMO10" }],
    });
    const theme = plan.phases.find((phase) => phase.name === "publish_theme");
    expect(theme.state).toBe("ready");
    expect(theme.commands[0].body.expectedRevision).toBe(2);
    expect(plan.phases.find((phase) => phase.name === "publish_navigation")).toMatchObject({
      state: "blocked",
      blockers: [expect.objectContaining({ code: "NAVIGATION_CAS_MISSING" })],
    });
    expect(plan.phases.find((phase) => phase.name === "activate_promotions")).toMatchObject({
      state: "blocked",
      blockers: [expect.objectContaining({ code: "PROMOTION_CAS_MISSING" })],
    });
  });
});

describe("category publication runtime", () => {
  it("resolves publication commands by category identity and verifies status", async () => {
    const get = vi.fn().mockResolvedValue({ id: "cat_1", slug: "footwear", status: "published" });
    const runtime = createDemoLifecycleRuntime({ get });
    const command = {
      logicalKey: "category:footwear:publish",
      identity: { id: "cat_1", slug: "footwear" },
      body: { status: "published" },
    };
    const current = await runtime.resolveCurrent(command);
    expect(get).toHaveBeenCalledWith("/api/v1/admin/categories/cat_1", command.logicalKey);
    expect(await runtime.matchesDesired(command, current)).toBe(true);
  });

  it("verifies persisted category image URLs rather than a request-only image object", async () => {
    const runtime = createDemoLifecycleRuntime({});
    const command = {
      logicalKey: "category:footwear",
      body: {
        slug: "footwear", name: "Footwear", description: "Shoes", metaTitle: "Footwear",
        metaDescription: "Daily shoes", canonicalPath: null, noIndex: false,
        excludeFromSitemap: false, status: "draft", image: { url: "https://media.example.test/category.webp" },
      },
    };
    expect(await runtime.matchesDesired(command, {
      ...command.body,
      image: undefined,
      imageUrl: command.body.image.url,
    })).toBe(true);
  });
});

describe("complete desired-state runtime", () => {
  it("detects product aggregate and matrix drift beyond names and option topology", async () => {
    const runtime = createDemoLifecycleRuntime({});
    const base = {
      logicalKey: "product:demo:activate",
      body: {
        slug: "demo", name: "Demo", description: "Copy", price: 1200, categoryId: "cat_1",
        isActive: true, discountType: "percentage", discountPercentage: 10, discountAmount: null,
        freeDelivery: true, metaTitle: "Demo title", metaDescription: "Demo description",
        canonicalPath: null, noIndex: false, excludeFromSitemap: false,
        excludeFromProductFeed: false, productCondition: "new",
        media: [{ id: "pmed_1", mediaId: "media_1", altText: "Demo", isPrimary: true }],
        attributes: [{ attributeId: "attr_brand", value: "Brand" }],
        additionalInfo: [{ id: "section_1", title: "Care", content: "Carefully", sortOrder: 0 }],
      },
    };
    expect(await runtime.matchesDesired(base, structuredClone(base.body))).toBe(true);
    expect(await runtime.matchesDesired(base, { ...structuredClone(base.body), metaDescription: "Drift" })).toBe(false);

    const matrix = {
      logicalKey: "product:demo:matrix",
      body: {
        options: [{ id: "option_1", name: "Finish", standardMapping: "color", values: [{ id: "value_1", value: "Black" }] }],
        variants: [{
          id: "variant_1", selectedOptionValueIds: ["value_1"], imageId: "pmed_1", sku: "DEMO-BLACK",
          price: 1200, stock: 4, trackInventory: true, weight: null, barcode: "AUTO-1",
          barcodeType: "code128", discountType: "percentage", discountPercentage: 10, discountAmount: null,
        }],
      },
    };
    const current = {
      options: matrix.body.options,
      variants: [{
        ...matrix.body.variants[0],
        selectedOptions: [{ optionValueId: "value_1" }],
        deletedAt: null,
      }],
    };
    expect(await runtime.matchesDesired(matrix, current)).toBe(true);
    current.variants[0].price = 1299;
    expect(await runtime.matchesDesired(matrix, current)).toBe(false);
  });
});

describe("resume authority", () => {
  it("restores safe authority into the next binder and records the new outcome", async () => {
    const fingerprint = demoApplyIntentFingerprint(demoStoreManifest);
    const baseRecord = createResumeRecord({
      intentFingerprint: fingerprint,
      phase: "stage_products",
      logicalKey: "product:vale-everyday-runners:base",
      status: "applied",
      authority: { id: "prod_vale", aggregateRevision: 8 },
      timestamp: "2026-07-13T12:00:00.000Z",
    });
    const restored = parseResumeJournal(`${JSON.stringify(baseRecord)}\n`, fingerprint);
    expect(restored.authorities.get(baseRecord.logicalKey)).toEqual({
      id: "prod_vale",
      aggregateRevision: 8,
    });

    const seen = [];
    const records = [];
    const result = await runDemoApplyLifecycle({
      manifest: demoStoreManifest,
      authorization: { confirmed: true, intentFingerprint: fingerprint },
      lifecycle: {
        phases: [{
          name: "stage_products",
          state: "ready",
          blockers: [],
          commands: [{ logicalKey: "product:vale-everyday-runners:matrix" }],
        }],
      },
      resumeRecords: [baseRecord],
      bindCommand: (command, context) => {
        seen.push(context.outputs.get(baseRecord.logicalKey));
        return command;
      },
      executeCommand: async () => ({
        logicalKey: "product:vale-everyday-runners:matrix",
        status: "applied",
        authority: { id: "prod_vale", aggregateRevision: 9 },
      }),
      recordResume: async (record) => records.push(record),
      now: () => new Date("2026-07-13T12:01:00.000Z"),
    });
    expect(result.status).toBe("complete");
    expect(seen).toEqual([{ id: "prod_vale", aggregateRevision: 8 }]);
    expect(records[0]).toMatchObject({
      schemaVersion: 2,
      logicalKey: "product:vale-everyday-runners:matrix",
      authority: { id: "prod_vale", aggregateRevision: 9 },
    });
  });

  it("fails closed on another intent, changed identity, or backwards revision", () => {
    const fingerprint = demoApplyIntentFingerprint(demoStoreManifest);
    const record = createResumeRecord({
      intentFingerprint: fingerprint,
      phase: "stage_products",
      logicalKey: "product:one:base",
      status: "applied",
      authority: { id: "prod_one", aggregateRevision: 3 },
    });
    expect(() => restoreResumeState([record], "0".repeat(64))).toThrow(/does not match/);
    expect(() => restoreResumeState([
      record,
      { ...record, authority: { id: "prod_other", aggregateRevision: 4 } },
    ], fingerprint)).toThrow(/identity changed/);
    expect(() => restoreResumeState([
      record,
      { ...record, authority: { id: "prod_one", aggregateRevision: 2 } },
    ], fingerprint)).toThrow(/moved backwards/);
  });
});

describe("blocked publication phases", () => {
  it("stops before later public phases instead of bypassing missing CAS", async () => {
    const publicationIntent = { navigation: { header: { navigation: [] } } };
    const fingerprint = demoApplyIntentFingerprint(demoStoreManifest, publicationIntent);
    const executeCommand = vi.fn();
    await expect(runDemoApplyLifecycle({
      manifest: demoStoreManifest,
      publicationIntent,
      authorization: { confirmed: true, intentFingerprint: fingerprint },
      lifecycle: {
        phases: [
          { name: "publish_navigation", state: "blocked", commands: [], blockers: [{ code: "NAVIGATION_CAS_MISSING", message: "Navigation is unversioned." }] },
          { name: "activate_heroes", state: "ready", commands: [{ logicalKey: "hero-slider:desktop:activate" }], blockers: [] },
        ],
      },
      executeCommand,
    })).rejects.toMatchObject({
      name: "DemoApplyPhaseBlockedError",
      phase: "publish_navigation",
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
