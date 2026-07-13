import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildExpectedAssets } from "../assets/expected-assets.mjs";
import { deterministicAssetFilename } from "../assets/profiles.mjs";
import { parseMediaUploadArgs } from "./cli.mjs";
import { runMediaUploadBridge } from "./run.mjs";
import { validateCompleteStagedInputs } from "./validate.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function media(logicalKey, role, kind = "image") {
  return {
    logicalKey,
    role,
    kind,
    altText: `${logicalKey} accessible description`,
    caption: kind === "video" ? `${logicalKey} walkthrough` : null,
    intendedCrop: role.startsWith("detail") ? "cover" : "contain",
  };
}

function manifestWith(product) {
  return {
    schemaVersion: 1,
    categories: [],
    products: [product],
    collections: [],
    heroes: [],
  };
}

function product(slug, mediaItems, retainedProductId = null) {
  return {
    logicalKey: `product:${slug}`,
    retainedProductId,
    slug,
    variants: [{ optionValues: [] }],
    media: mediaItems,
  };
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(manifest, remoteReuse = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scalius-media-upload-"));
  directories.push(directory);
  const stagedDir = path.join(directory, "staged");
  await mkdir(stagedDir);
  const records = [];
  const stagedAssets = [];
  for (const expected of buildExpectedAssets(manifest)) {
    const sourceBytes = Buffer.from(`source:${expected.logicalKey}`);
    const outputBytes = expected.kind === "video" ? sourceBytes : Buffer.from(`webp:${expected.logicalKey}`);
    const sourceSha256 = sha(sourceBytes);
    const originalMime = expected.kind === "video" ? "video/mp4" : "image/png";
    const filename = deterministicAssetFilename({ ...expected, mime: originalMime }, sourceSha256);
    await writeFile(path.join(stagedDir, filename), outputBytes);
    const record = {
      logicalKey: expected.logicalKey,
      status: "approved",
      sourceKind: "generated-original",
      sourceFile: `${expected.logicalKey.replace(/[^a-z0-9]+/giu, "-")}.${expected.kind === "video" ? "mp4" : "png"}`,
      creator: "Scalius demo studio",
      license: { code: "Generated-Original", url: "https://www.scalius.com/asset-rights", attribution: "" },
      generation: { prompt: "Original unbranded demo object", model: "Test generator" },
      acquiredAt: "2026-07-13",
      verifiedAt: "2026-07-13",
      sha256: sourceSha256,
      original: { mime: originalMime, bytes: sourceBytes.length, width: 1200, height: 900 },
      cropPosition: "centre",
      rightsReview: {
        reviewedBy: "test-reviewer",
        noWatermark: true,
        noVisibleBranding: true,
        noTrademarkedCharacter: true,
        noIdentifiableEndorser: true,
        optionAppearanceVerified: true,
      },
      ...(remoteReuse[expected.logicalKey] ? { remoteReuse: remoteReuse[expected.logicalKey] } : {}),
    };
    records.push(record);
    stagedAssets.push({
      logicalKey: expected.logicalKey,
      kind: expected.kind,
      profile: expected.profile,
      status: "staged",
      errors: [],
      source: { sha256: sourceSha256, mime: originalMime, bytes: sourceBytes.length, width: 1200, height: 900 },
      output: {
        filename,
        mime: expected.kind === "video" ? originalMime : "image/webp",
        bytes: outputBytes.length,
        width: expected.kind === "video" ? 1200 : 1600,
        height: expected.kind === "video" ? 900 : 1600,
        sha256: sha(outputBytes),
      },
    });
  }
  return {
    directory,
    stagedDir,
    sourceManifest: { schemaVersion: 1, assets: records },
    stagedReport: { schemaVersion: 1, mode: "stage", ready: true, manifestErrors: [], assets: stagedAssets },
    journalPath: path.join(directory, "journal.jsonl"),
    outputPath: path.join(directory, "apply-readiness.json"),
  };
}

describe("demo-store Media upload bridge", () => {
  it("rejects partial staging before any remote work", async () => {
    const manifest = manifestWith(product("test", [media("test:primary", "primary")]));
    const input = await fixture(manifest);
    input.stagedReport.ready = false;
    await expect(validateCompleteStagedInputs({ manifest, ...input, requiredAssetCount: 1 })).rejects.toThrow("complete stage-mode readiness");
  });

  it("reuses exact retained image, video, and poster identities without uploading", async () => {
    const retainedId = "prod_retained_123";
    const manifest = manifestWith(product("retained", [
      media("retained:primary", "primary"),
      media("retained:video", "video", "video"),
      media("retained:poster", "poster"),
    ], retainedId));
    const reuse = {
      "retained:primary": { productId: retainedId, mediaId: "media_primary_1" },
      "retained:video": { productId: retainedId, mediaId: "media_video_1" },
      "retained:poster": { productId: retainedId, mediaId: "media_poster_1" },
    };
    const input = await fixture(manifest, reuse);
    const recordByKey = new Map(input.sourceManifest.assets.map((record) => [record.logicalKey, record]));
    const remoteMedia = [
      { id: "media_primary_1", filename: "current-primary.png", kind: "image", mimeType: "image/png", size: recordByKey.get("retained:primary").original.bytes, url: "https://cdn.test/primary", status: "ready", version: 2, createdAt: "2026-07-13T00:00:00.000Z", width: 1200, height: 900, posterMediaId: null },
      { id: "media_video_1", filename: "current-video.mp4", kind: "video", mimeType: "video/mp4", size: recordByKey.get("retained:video").original.bytes, url: "https://cdn.test/video", status: "ready", version: 2, createdAt: "2026-07-13T00:00:00.000Z", width: 1200, height: 900, posterMediaId: "media_poster_1" },
      { id: "media_poster_1", filename: "current-poster.png", kind: "image", mimeType: "image/png", size: recordByKey.get("retained:poster").original.bytes, url: "https://cdn.test/poster", status: "ready", version: 2, createdAt: "2026-07-13T00:00:00.000Z", width: 1200, height: 900, posterMediaId: null },
    ];
    const state = {
      capturedAt: "2026-07-13T00:00:00.000Z",
      media: remoteMedia,
      retainedDetails: [{
        id: retainedId,
        slug: "retained",
        media: [
          { mediaId: "media_primary_1", status: "ready", posterMediaId: null },
          { mediaId: "media_video_1", status: "ready", posterMediaId: "media_poster_1" },
        ],
      }],
    };
    const mediaClient = { initiate: vi.fn(), getSession: vi.fn(), uploadPart: vi.fn(), complete: vi.fn(), update: vi.fn() };
    const result = await runMediaUploadBridge({
      manifest,
      ...input,
      readClient: {},
      mediaClient,
      readState: vi.fn().mockResolvedValue(state),
      hashRemote: vi.fn(async (file) => recordByKey.get(Object.entries(reuse).find(([, value]) => value.mediaId === file.id)[0]).sha256),
      now: () => new Date("2026-07-13T01:00:00.000Z"),
      requiredAssetCount: 3,
    });
    expect(result.summary).toMatchObject({ total: 3, reused: 3, uploaded: 0, posterLinks: 1 });
    expect(mediaClient.initiate).not.toHaveBeenCalled();
    expect(mediaClient.uploadPart).not.toHaveBeenCalled();
    expect(mediaClient.update).not.toHaveBeenCalled();
    expect(result.report.assets.find((asset) => asset.logicalKey === "retained:video")).toMatchObject({ posterLogicalKey: "retained:poster", posterMediaId: "media_poster_1" });
    expect(JSON.parse(await readFile(input.outputPath, "utf8")).status).toBe("complete");
  });

  it("uploads files and parts strictly sequentially and emits fresh exact readiness", async () => {
    const manifest = manifestWith(product("new", [media("new:primary", "primary"), media("new:detail", "detail")]));
    const input = await fixture(manifest);
    const events = [];
    const remoteMedia = [];
    let sequence = 0;
    const mediaClient = {
      getSession: vi.fn(),
      initiate: vi.fn(async (request) => {
        sequence += 1;
        events.push(`initiate:${request.filename}`);
        return { id: `session_${sequence}`, mediaId: `media_new_${sequence}`, filename: request.filename, mimeType: request.mimeType, size: request.size, expectedParts: 2, partSize: Math.ceil(request.size / 2), state: "initiated", uploadedParts: [] };
      }),
      uploadPart: vi.fn(async (sessionId, partNumber) => { events.push(`part:${sessionId}:${partNumber}`); }),
      complete: vi.fn(async (sessionId) => {
        events.push(`complete:${sessionId}`);
        const index = Number(sessionId.split("_")[1]) - 1;
        const staged = input.stagedReport.assets[index];
        return { id: `media_new_${index + 1}`, filename: staged.output.filename, kind: "image", mimeType: "image/webp", size: staged.output.bytes, url: `https://cdn.test/${index + 1}`, status: "ready", version: 1, createdAt: "2026-07-13T00:00:00.000Z", width: null, height: null, posterMediaId: null };
      }),
      update: vi.fn(async (_id, update) => {
        const index = Number(_id.split("_").at(-1)) - 1;
        events.push(`update:${_id}`);
        const staged = input.stagedReport.assets[index];
        const file = { id: _id, filename: staged.output.filename, kind: "image", mimeType: "image/webp", size: staged.output.bytes, url: `https://cdn.test/${index + 1}`, status: "ready", version: update.expectedVersion + 1, createdAt: "2026-07-13T00:00:00.000Z", width: update.width, height: update.height, altText: update.altText, posterMediaId: null };
        remoteMedia[index] = file;
        return file;
      }),
    };
    const result = await runMediaUploadBridge({
      manifest,
      ...input,
      readClient: {},
      mediaClient,
      readState: vi.fn(async () => ({ capturedAt: "2026-07-13T00:00:00.000Z", media: remoteMedia.filter(Boolean), retainedDetails: [] })),
      hashRemote: vi.fn(),
      now: () => new Date("2026-07-13T01:00:00.000Z"),
      requiredAssetCount: 2,
    });
    expect(result.summary).toMatchObject({ total: 2, uploaded: 2, reused: 0 });
    expect(events).toEqual([
      expect.stringMatching(/^initiate:/u), "part:session_1:1", "part:session_1:2", "complete:session_1", "update:media_new_1",
      expect.stringMatching(/^initiate:/u), "part:session_2:1", "part:session_2:2", "complete:session_2", "update:media_new_2",
    ]);
    expect(result.report.assets.every((asset) => asset.status === "ready" && asset.sha256.length === 64)).toBe(true);
  });

  it("rejects all credential and session arguments", () => {
    for (const argument of ["--email", "--password=x", "--cookie", "--token=x", "--secret"]) {
      expect(() => parseMediaUploadArgs([argument])).toThrow(/interactive prompt/);
    }
  });

  it("fails closed when the approved batch is not exactly 237 assets", async () => {
    const manifest = manifestWith(product("test", [media("test:primary", "primary")]));
    const input = await fixture(manifest);
    await expect(validateCompleteStagedInputs({ manifest, ...input })).rejects.toThrow("exactly 237 approved assets");
  });
});
