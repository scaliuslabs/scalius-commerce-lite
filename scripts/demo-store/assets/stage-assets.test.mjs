import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildExpectedAssets } from "./expected-assets.mjs";
import { ASSET_PROFILES, deterministicAssetFilename } from "./profiles.mjs";
import { validateSourceManifest } from "./provenance.mjs";
import { assessAndStageAssets, normalizeImage, summarizeAssetProgress } from "./stage-assets.mjs";

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

async function directLegacyNormalize(source, profile, cropPosition = "centre") {
  let pipeline = sharp(source, { animated: false, failOn: "error" })
    .rotate()
    .toColorspace("srgb");
  if (profile.fit === "contain-safe") {
    const safeWidth = Math.round(profile.width * profile.safeArea);
    const safeHeight = Math.round(profile.height * profile.safeArea);
    pipeline = pipeline
      .resize({
        width: safeWidth,
        height: safeHeight,
        fit: "contain",
        background: { r: 255, g: 255, b: 255, alpha: 1 },
        withoutEnlargement: false,
      })
      .extend({
        top: Math.floor((profile.height - safeHeight) / 2),
        bottom: Math.ceil((profile.height - safeHeight) / 2),
        left: Math.floor((profile.width - safeWidth) / 2),
        right: Math.ceil((profile.width - safeWidth) / 2),
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      });
  } else {
    pipeline = pipeline.resize({
      width: profile.width,
      height: profile.height,
      fit: "cover",
      position: cropPosition,
      withoutEnlargement: false,
    });
  }
  return pipeline.webp({ quality: profile.quality, effort: 5 }).toBuffer();
}

async function coloredPixelBounds(image, predicate) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width;
  let right = -1;
  let top = info.height;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      if (!predicate(data[offset], data[offset + 1], data[offset + 2])) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left
    ? null
    : { left, top, width: right - left + 1, height: bottom - top + 1 };
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

  it("reports exact asset and complete-owner readiness without treating partial products as ready", () => {
    const expected = [
      expectedProduct(),
      { ...expectedProduct(), logicalKey: "product:test:detail", role: "detail", profile: "product-cover" },
      { ...expectedProduct(), logicalKey: "product:other:primary", owner: "product:other" },
      { ...expectedProduct(), logicalKey: "category:test:image", owner: "category:test", role: "category", profile: "category" },
      { ...expectedProduct(), logicalKey: "hero:test:desktop", owner: "hero:test", role: "hero-desktop", profile: "hero-desktop" },
      { ...expectedProduct(), logicalKey: "hero:test:mobile", owner: "hero:test", role: "hero-mobile", profile: "hero-mobile" },
    ];
    const assessed = expected.map((asset) => ({
      logicalKey: asset.logicalKey,
      status: ["product:test:primary", "product:other:primary", "hero:test:desktop"].includes(asset.logicalKey)
        ? "ready-to-stage"
        : "missing-source-record",
    }));

    expect(summarizeAssetProgress(expected, assessed, "ready-to-stage")).toEqual({
      assets: { ready: 3, total: 6, remaining: 3 },
      products: { ready: 1, total: 2, remaining: 1 },
      categories: { ready: 0, total: 1, remaining: 1 },
      heroes: { ready: 0, total: 1, remaining: 1 },
      remainingByOwner: [
        {
          owner: "category:test",
          kind: "categories",
          ready: 0,
          total: 1,
          remaining: 1,
          missing: ["category:test:image"],
        },
        {
          owner: "hero:test",
          kind: "heroes",
          ready: 1,
          total: 2,
          remaining: 1,
          missing: ["hero:test:mobile"],
        },
        {
          owner: "product:test",
          kind: "products",
          ready: 1,
          total: 2,
          remaining: 1,
          missing: ["product:test:detail"],
        },
      ],
    });
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

  it("removes landscape near-white exterior margins before contain-safe resize", async () => {
    const product = await sharp({
      create: { width: 900, height: 600, channels: 3, background: "#2450a4" },
    }).png().toBuffer();
    const source = await sharp({
      create: { width: 1536, height: 1024, channels: 3, background: "#ffffff" },
    }).composite([{ input: product, left: 318, top: 212 }]).png().toBuffer();

    const first = await normalizeImage(source, ASSET_PROFILES["product-contain"], "centre");
    const second = await normalizeImage(source, ASSET_PROFILES["product-contain"], "centre");
    expect(first.equals(second)).toBe(true);
    expect(await sharp(first).metadata()).toMatchObject({ format: "webp", width: 1600, height: 1600 });
    const bounds = await coloredPixelBounds(first, (red, green, blue) =>
      blue > red + 30 && blue > green + 10,
    );
    expect(bounds).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    expect(bounds.width).toBeGreaterThanOrEqual(1260);
    expect(bounds.height).toBeGreaterThanOrEqual(830);
  });

  it("retains a white product and its soft shadow while trimming exterior white", async () => {
    const shadow = await sharp({
      create: { width: 540, height: 390, channels: 3, background: "#d1d5db" },
    }).png().toBuffer();
    const outline = await sharp({
      create: { width: 500, height: 340, channels: 3, background: "#e5e7eb" },
    }).png().toBuffer();
    const product = await sharp({
      create: { width: 490, height: 330, channels: 3, background: "#ffffff" },
    }).png().toBuffer();
    const source = await sharp({
      create: { width: 1000, height: 800, channels: 3, background: "#ffffff" },
    }).composite([
      { input: shadow, left: 230, top: 230 },
      { input: outline, left: 250, top: 190 },
      { input: product, left: 255, top: 195 },
    ]).png().toBuffer();

    const normalized = await normalizeImage(source, ASSET_PROFILES["product-contain"], "centre");
    const retainedBounds = await coloredPixelBounds(normalized, (red, green, blue) =>
      red < 245 || green < 245 || blue < 245,
    );
    expect(retainedBounds.width).toBeGreaterThan(1100);
    expect(retainedBounds.height).toBeGreaterThan(800);
    const center = await sharp(normalized)
      .extract({ left: 750, top: 720, width: 100, height: 100 })
      .stats();
    expect(center.channels.slice(0, 3).every((channel) => channel.mean > 248)).toBe(true);
  });

  it("does not trim an opaque colored contain background or any cover source", async () => {
    const colored = await sharp({
      create: { width: 1536, height: 1024, channels: 3, background: "#2450a4" },
    }).png().toBuffer();
    const contained = await normalizeImage(colored, ASSET_PROFILES["product-contain"], "centre");
    const legacyContained = await directLegacyNormalize(colored, ASSET_PROFILES["product-contain"]);
    expect(contained.equals(legacyContained)).toBe(true);

    const whiteMargin = await sharp({
      create: { width: 1536, height: 1024, channels: 3, background: "#ffffff" },
    }).composite([{
      input: await sharp({
        create: { width: 500, height: 400, channels: 3, background: "#2450a4" },
      }).png().toBuffer(),
      left: 518,
      top: 312,
    }]).png().toBuffer();
    const covered = await normalizeImage(whiteMargin, ASSET_PROFILES["product-cover"], "centre");
    const legacyCovered = await directLegacyNormalize(whiteMargin, ASSET_PROFILES["product-cover"]);
    expect(covered.equals(legacyCovered)).toBe(true);
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
