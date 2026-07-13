import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildExpectedAssets } from "./expected-assets.mjs";
import { ASSET_PROFILES, deterministicAssetFilename } from "./profiles.mjs";
import { validateSourceManifest } from "./provenance.mjs";
import { assessAndStageAssets } from "./stage-assets.mjs";

const requireFromStorefront = createRequire(
  new URL("../../../apps/storefront/package.json", import.meta.url),
);
const sharp = requireFromStorefront("sharp");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

function expectedProduct() {
  return {
    logicalKey: "product:test:primary",
    owner: "product:test",
    kind: "image",
    role: "primary",
    altText: "Test product in a full primary view",
    caption: null,
    intendedCrop: "contain",
    profile: "product-contain",
  };
}

function approvedRecord({ bytes, width, height, sha }) {
  return {
    logicalKey: "product:test:primary",
    status: "approved",
    sourceKind: "merchant-owned",
    sourceFile: "test-source.png",
    sourcePageUrl: null,
    originalFileUrl: null,
    merchantOwnershipReference: "Scalius demo asset release 2026-07-13",
    creator: "Scalius demo studio",
    license: {
      code: "Proprietary-Merchant-Owned",
      url: "https://www.scalius.com/asset-rights",
      attribution: "",
    },
    acquiredAt: "2026-07-13",
    verifiedAt: "2026-07-13",
    sha256: sha,
    original: { mime: "image/png", bytes, width, height },
    cropPosition: "centre",
    rightsReview: {
      reviewedBy: "demo-studio",
      noWatermark: true,
      noVisibleBranding: true,
      noTrademarkedCharacter: true,
      noIdentifiableEndorser: true,
      optionAppearanceVerified: true,
    },
  };
}

describe("demo asset staging", () => {
  it("derives the complete blueprint profile contract", () => {
    const expected = buildExpectedAssets();
    expect(expected).toHaveLength(237);
    expect(expected.filter((asset) => asset.profile === "category")).toHaveLength(5);
    expect(expected.filter((asset) => asset.profile === "hero-desktop")).toHaveLength(3);
    expect(expected.filter((asset) => asset.profile === "hero-mobile")).toHaveLength(3);
    expect(expected.filter((asset) => asset.profile === "video")).toHaveLength(3);
    expect(ASSET_PROFILES["product-contain"]).toMatchObject({ width: 1600, height: 1600, safeArea: 0.8 });
    expect(ASSET_PROFILES.category).toMatchObject({ width: 1600, height: 1000 });
    expect(ASSET_PROFILES["hero-desktop"]).toMatchObject({ width: 2400, height: 900 });
    expect(ASSET_PROFILES["hero-mobile"]).toMatchObject({ width: 1080, height: 1350 });
  });

  it("fails closed on incomplete rights and share-alike provenance", () => {
    const expected = [expectedProduct()];
    const record = approvedRecord({ bytes: 1, width: 1, height: 1, sha: "a".repeat(64) });
    record.sourceKind = "wikimedia-commons";
    record.sourcePageUrl = "https://commons.wikimedia.org/wiki/File:Example.jpg";
    record.originalFileUrl = "https://upload.wikimedia.org/example.jpg";
    record.license.code = "CC-BY-SA-4.0";
    record.license.attribution = "Example creator";
    record.rightsReview.noVisibleBranding = false;

    const result = validateSourceManifest({ schemaVersion: 1, assets: [record] }, expected);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("license.code is not approved"),
      expect.stringContaining("rightsReview must explicitly pass"),
    ]));
  });

  it("normalizes an approved product source into a deterministic contain-safe WebP", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scalius-assets-"));
    temporaryDirectories.push(directory);
    const sourceDir = path.join(directory, "source");
    const outputDir = path.join(directory, "output");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceDir));
    const source = await sharp({
      create: { width: 600, height: 300, channels: 3, background: "#2450a4" },
    }).png().toBuffer();
    await writeFile(path.join(sourceDir, "test-source.png"), source);
    const digest = createHash("sha256").update(source).digest("hex");
    const record = approvedRecord({ bytes: source.length, width: 600, height: 300, sha: digest });

    const report = await assessAndStageAssets({
      sourceManifest: { schemaVersion: 1, assets: [record] },
      sourceDir,
      outputDir,
      stage: true,
      expectedAssets: [expectedProduct()],
    });

    expect(report.ready).toBe(true);
    expect(report.summary).toMatchObject({ total: 1, staged: 1, manifestErrors: 0 });
    const filenames = await readdir(outputDir);
    expect(filenames).toEqual([
      deterministicAssetFilename(
        { ...expectedProduct(), mime: "image/png" },
        digest,
      ),
    ]);
    const normalized = await readFile(path.join(outputDir, filenames[0]));
    expect(await sharp(normalized).metadata()).toMatchObject({
      format: "webp",
      width: 1600,
      height: 1600,
      space: "srgb",
    });
    const edgeRegion = await sharp(normalized)
      .extract({ left: 0, top: 0, width: 120, height: 120 })
      .toBuffer();
    const centerRegion = await sharp(normalized)
      .extract({ left: 700, top: 700, width: 200, height: 200 })
      .toBuffer();
    const edge = await sharp(edgeRegion).stats();
    const center = await sharp(centerRegion).stats();
    expect(edge.channels.slice(0, 3).every((channel) => channel.mean > 245)).toBe(true);
    expect(center.channels[2].mean).toBeGreaterThan(center.channels[0].mean);
  });

  it("reports SHA mismatches without writing an output", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scalius-assets-"));
    temporaryDirectories.push(directory);
    const sourceDir = path.join(directory, "source");
    const outputDir = path.join(directory, "output");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceDir));
    const source = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer();
    await writeFile(path.join(sourceDir, "test-source.png"), source);
    const record = approvedRecord({ bytes: source.length, width: 10, height: 10, sha: "a".repeat(64) });

    const report = await assessAndStageAssets({
      sourceManifest: { schemaVersion: 1, assets: [record] },
      sourceDir,
      outputDir,
      stage: true,
      expectedAssets: [expectedProduct()],
    });
    expect(report.ready).toBe(false);
    expect(report.assets[0]).toMatchObject({ status: "source-invalid" });
    expect(report.assets[0].errors[0]).toContain("SHA-256 mismatch");
    await expect(readdir(outputDir)).rejects.toThrow();
  });
});
