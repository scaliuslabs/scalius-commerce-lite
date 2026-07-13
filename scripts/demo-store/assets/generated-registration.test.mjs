import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertPrivateDataPath,
  registerGeneratedAssets,
} from "./generated-registration.mjs";
import { parseGeneratedRegistrationArgs } from "./register-generated.mjs";

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

const expectedAssets = [
  { logicalKey: "product:test:primary", kind: "image" },
  { logicalKey: "product:test:variant-sand", kind: "image" },
];

function registration(directory, sourceFile, logicalKeys) {
  return {
    manifestPath: path.join(directory, "private-manifest.json"),
    sourceDir: path.join(directory, "sources"),
    sourceFile,
    logicalKeys,
    prompt: "A clean fictional product on a neutral background; no logo or text.",
    model: "gpt-image-2",
    creator: "Scalius demo studio",
    rightsUrl: "https://www.scalius.com/asset-rights",
    acquiredAt: "2026-07-12",
    verifiedAt: "2026-07-13",
    cropPosition: "centre",
    rightsReview: {
      reviewedBy: "demo-reviewer",
      noWatermark: true,
      noVisibleBranding: true,
      noTrademarkedCharacter: true,
      noIdentifiableEndorser: true,
      optionAppearanceVerified: true,
    },
    expectedAssets,
    today: "2026-07-13",
  };
}

async function createImage(filePath, background) {
  const bytes = await sharp({
    create: { width: 64, height: 48, channels: 3, background },
  }).png().toBuffer();
  await writeFile(filePath, bytes);
  return bytes;
}

describe("private generated-asset registration", () => {
  it("atomically upserts multiple exact keys with inspected local-file facts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scalius-generated-assets-"));
    temporaryDirectories.push(directory);
    const sourceDir = path.join(directory, "sources");
    await mkdir(sourceDir);
    const firstFile = path.join(sourceDir, "first.png");
    await createImage(firstFile, "#b99a70");

    const first = await registerGeneratedAssets(registration(
      directory,
      firstFile,
      ["product:test:primary", "product:test:variant-sand"],
    ));
    expect(first.logicalKeys).toEqual(["product:test:primary", "product:test:variant-sand"]);
    expect(first.source).toMatchObject({ kind: "image", mime: "image/png", width: 64, height: 48 });
    const initial = JSON.parse(await readFile(first.manifestPath, "utf8"));
    expect(initial.assets).toHaveLength(2);
    expect(initial.assets[0]).toMatchObject({
      logicalKey: "product:test:primary",
      sourceKind: "generated-original",
      sourceFile: "first.png",
      license: { code: "Generated-Original" },
      original: { mime: "image/png", width: 64, height: 48 },
    });
    expect(initial.assets[0].sha256).toBe(initial.assets[1].sha256);
    expect((await stat(first.manifestPath)).mode & 0o777).toBe(0o600);

    const secondFile = path.join(sourceDir, "second.png");
    await createImage(secondFile, "#1f2937");
    await registerGeneratedAssets(registration(
      directory,
      secondFile,
      ["product:test:primary"],
    ));
    const updated = JSON.parse(await readFile(first.manifestPath, "utf8"));
    expect(updated.assets).toHaveLength(2);
    expect(updated.assets.find((record) => record.logicalKey === "product:test:primary").sourceFile).toBe("second.png");
    expect(updated.assets.find((record) => record.logicalKey === "product:test:variant-sand").sourceFile).toBe("first.png");
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("refuses repository paths outside .wrangler", () => {
    const repoRoot = path.join(os.tmpdir(), "example-repo");
    expect(() => assertPrivateDataPath(
      path.join(repoRoot, "scripts/demo-store/assets/asset-sources.json"),
      "Generated-asset manifest",
      repoRoot,
    )).toThrow("must be under .wrangler");
    expect(() => assertPrivateDataPath(
      path.join(repoRoot, ".wrangler/demo-store-assets/private.json"),
      "Generated-asset manifest",
      repoRoot,
    )).not.toThrow();
  });

  it("does not overwrite a checked-in source manifest", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scalius-generated-assets-"));
    temporaryDirectories.push(directory);
    const repoRoot = path.join(directory, "repo");
    const manifestPath = path.join(repoRoot, "scripts/demo-store/assets/asset-sources.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    const sentinel = '{"schemaVersion":1,"assets":[],"checkedIn":true}\n';
    await writeFile(manifestPath, sentinel);
    const sourceDir = path.join(directory, "private-sources");
    await mkdir(sourceDir);
    const sourceFile = path.join(sourceDir, "source.png");
    await createImage(sourceFile, "#f3f4f6");
    const input = registration(directory, sourceFile, ["product:test:primary"]);
    input.manifestPath = manifestPath;
    input.sourceDir = sourceDir;
    input.repoRoot = repoRoot;

    await expect(registerGeneratedAssets(input)).rejects.toThrow("must be under .wrangler");
    expect(await readFile(manifestPath, "utf8")).toBe(sentinel);
  });

  it("fails closed before writing when any rights review is not explicit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scalius-generated-assets-"));
    temporaryDirectories.push(directory);
    const sourceDir = path.join(directory, "sources");
    await mkdir(sourceDir);
    const sourceFile = path.join(sourceDir, "source.png");
    await createImage(sourceFile, "white");
    const input = registration(directory, sourceFile, ["product:test:primary"]);
    input.rightsReview.optionAppearanceVerified = false;

    await expect(registerGeneratedAssets(input)).rejects.toThrow("rightsReview must explicitly pass");
    await expect(readFile(input.manifestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires every CLI rights confirmation", () => {
    const base = [
      "--manifest", "/private/manifest.json",
      "--source-dir", "/private/source",
      "--file", "/private/source/image.png",
      "--logical-key", "product:test:primary",
      "--prompt", "prompt",
      "--model", "gpt-image-2",
      "--creator", "studio",
      "--rights-url", "https://example.test/rights",
      "--reviewed-by", "reviewer",
      "--acquired-at", "2026-07-12",
      "--verified-at", "2026-07-13",
      "--confirm-no-watermark",
      "--confirm-no-visible-branding",
      "--confirm-no-trademarked-character",
      "--confirm-no-identifiable-endorser",
    ];
    expect(() => parseGeneratedRegistrationArgs(base)).toThrow("missing optionAppearanceVerified");
    expect(parseGeneratedRegistrationArgs([...base, "--confirm-option-appearance"]).logicalKeys)
      .toEqual(["product:test:primary"]);
  });
});
