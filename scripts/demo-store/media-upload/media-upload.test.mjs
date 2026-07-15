import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildExpectedAssets } from "../assets/expected-assets.mjs";
import { deterministicAssetFilename } from "../assets/profiles.mjs";
import { parseMediaUploadArgs } from "./cli.mjs";
import { createMediaUploadClient } from "./client.mjs";
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

function opaqueId(prefix, seed) {
  return `${prefix}_${`${seed}${"x".repeat(21)}`.slice(0, 21)}`;
}

async function fixture(manifest, remoteReuse = {}, retainedReplacement = {}) {
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
      ...(retainedReplacement[expected.logicalKey] ? { retainedReplacement: retainedReplacement[expected.logicalKey] } : {}),
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
  it("paces durable Media commands instead of concentrating D1 writes", async () => {
    const sleeps = [];
    const fetchImpl = vi.fn(async (_url, init) => new Response(JSON.stringify({
      success: true,
      data: init.method === "POST"
        ? { session: { id: opaqueId("mup", "paced"), mediaId: opaqueId("media", "paced") } }
        : { session: { id: opaqueId("mup", "paced"), mediaId: opaqueId("media", "paced") } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createMediaUploadClient({
      adminOrigin: "https://dashboard.test",
      cookieHeader: "session=opaque",
      fetchImpl,
      minimumRequestIntervalMs: 250,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      now: () => 1_000,
    });

    await client.initiate({ filename: "demo.webp", mimeType: "image/webp", size: 100 });
    await client.getSession(opaqueId("mup", "paced"));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([250]);
  });

  it("rejects partial staging before any remote work", async () => {
    const manifest = manifestWith(product("test", [media("test:primary", "primary")]));
    const input = await fixture(manifest);
    input.stagedReport.ready = false;
    await expect(validateCompleteStagedInputs({ manifest, ...input, requiredAssetCount: 1 })).rejects.toThrow("complete stage-mode readiness");
  });

  it("reuses exact retained image, video, and poster identities without uploading", async () => {
    const retainedId = "prod_retained_123";
    const primaryMediaId = opaqueId("media", "primary-1");
    const videoMediaId = opaqueId("media", "video-1");
    const posterMediaId = opaqueId("media", "poster-1");
    const manifest = manifestWith(product("retained", [
      media("retained:primary", "primary"),
      media("retained:video", "video", "video"),
      media("retained:poster", "poster"),
    ], retainedId));
    const reuse = {
      "retained:primary": { productId: retainedId, mediaId: primaryMediaId },
      "retained:video": { productId: retainedId, mediaId: videoMediaId },
      "retained:poster": { productId: retainedId, mediaId: posterMediaId },
    };
    const input = await fixture(manifest, reuse);
    const recordByKey = new Map(input.sourceManifest.assets.map((record) => [record.logicalKey, record]));
    const remoteMedia = [
      { id: primaryMediaId, filename: "current-primary.png", kind: "image", mimeType: "image/png", size: recordByKey.get("retained:primary").original.bytes, url: "https://cdn.test/primary", status: "ready", version: 2, createdAt: "2026-07-13T00:00:00.000Z", width: 1200, height: 900, posterMediaId: null },
      { id: videoMediaId, filename: "current-video.mp4", kind: "video", mimeType: "video/mp4", size: recordByKey.get("retained:video").original.bytes, url: "https://cdn.test/video", status: "ready", version: 2, createdAt: "2026-07-13T00:00:00.000Z", width: 1200, height: 900, posterMediaId },
      { id: posterMediaId, filename: "current-poster.png", kind: "image", mimeType: "image/png", size: recordByKey.get("retained:poster").original.bytes, url: "https://cdn.test/poster", status: "ready", version: 2, createdAt: "2026-07-13T00:00:00.000Z", width: 1200, height: 900, posterMediaId: null },
    ];
    const state = {
      capturedAt: "2026-07-13T00:00:00.000Z",
      media: remoteMedia,
      retainedDetails: [{
        id: retainedId,
        slug: "retained",
        media: [
          { mediaId: primaryMediaId, status: "ready", posterMediaId: null },
          { mediaId: videoMediaId, status: "ready", posterMediaId },
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
    expect(result.report.assets.find((asset) => asset.logicalKey === "retained:video")).toMatchObject({ posterLogicalKey: "retained:poster", posterMediaId });
    expect(JSON.parse(await readFile(input.outputPath, "utf8")).status).toBe("complete");
  });

  it("uploads files and parts strictly sequentially and emits fresh exact readiness", async () => {
    const manifest = manifestWith(product("new", [media("new:primary", "primary"), media("new:detail", "detail")]));
    const input = await fixture(manifest);
    const events = [];
    const remoteMedia = [];
    const sessionIndexes = new Map();
    const mediaIndexes = new Map();
    let sequence = 0;
    const mediaClient = {
      getSession: vi.fn(),
      initiate: vi.fn(async (request) => {
        sequence += 1;
        const sessionId = opaqueId("mup", `session-${sequence}`);
        const mediaId = opaqueId("media", `new-${sequence}`);
        sessionIndexes.set(sessionId, sequence - 1);
        mediaIndexes.set(mediaId, sequence - 1);
        events.push(`initiate:${request.filename}`);
        return { id: sessionId, mediaId, filename: request.filename, mimeType: request.mimeType, size: request.size, expectedParts: 2, partSize: Math.ceil(request.size / 2), state: "initiated", uploadedParts: [] };
      }),
      uploadPart: vi.fn(async (sessionId, partNumber) => { events.push(`part:${sessionId}:${partNumber}`); }),
      complete: vi.fn(async (sessionId) => {
        events.push(`complete:${sessionId}`);
        const index = sessionIndexes.get(sessionId);
        const staged = input.stagedReport.assets[index];
        return { id: opaqueId("media", `new-${index + 1}`), filename: staged.output.filename, kind: "image", mimeType: "image/webp", size: staged.output.bytes, url: `https://cdn.test/${index + 1}`, status: "ready", version: 1, createdAt: "2026-07-13T00:00:00.000Z", width: null, height: null, posterMediaId: null };
      }),
      update: vi.fn(async (_id, update) => {
        const index = mediaIndexes.get(_id);
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
    const firstSessionId = opaqueId("mup", "session-1");
    const secondSessionId = opaqueId("mup", "session-2");
    const firstMediaId = opaqueId("media", "new-1");
    const secondMediaId = opaqueId("media", "new-2");
    expect(events).toEqual([
      expect.stringMatching(/^initiate:/u), `part:${firstSessionId}:1`, `part:${firstSessionId}:2`, `complete:${firstSessionId}`, `update:${firstMediaId}`,
      expect.stringMatching(/^initiate:/u), `part:${secondSessionId}:1`, `part:${secondSessionId}:2`, `complete:${secondSessionId}`, `update:${secondMediaId}`,
    ]);
    expect(result.report.assets.every((asset) => asset.status === "ready" && asset.sha256.length === 64)).toBe(true);
  });

  it("uploads generated replacements for retained Media with exact old authority", async () => {
    const retainedId = "prod_retained_123";
    const logicalKey = "retained:primary";
    const oldMediaId = opaqueId("media", "old-primary");
    const newMediaId = opaqueId("media", "new-primary");
    const sessionId = opaqueId("mup", "replacement");
    const manifest = manifestWith(product("retained", [media(logicalKey, "primary")], retainedId));
    const replacements = {
      [logicalKey]: { productId: retainedId, mediaId: oldMediaId },
    };
    const input = await fixture(manifest, {}, replacements);
    const staged = input.stagedReport.assets[0];
    const old = {
      id: oldMediaId, filename: "old.png", kind: "image", mimeType: "image/png",
      size: 12, url: "https://cdn.test/old", status: "ready", version: 1,
      createdAt: "2026-07-13T00:00:00.000Z", width: 1200, height: 900, posterMediaId: null,
    };
    const remoteMedia = [old];
    const mediaClient = {
      getSession: vi.fn(),
      initiate: vi.fn(async (request) => ({
        id: sessionId, mediaId: newMediaId, filename: request.filename,
        mimeType: request.mimeType, size: request.size, expectedParts: 1,
        partSize: request.size, state: "initiated", uploadedParts: [],
      })),
      uploadPart: vi.fn(),
      complete: vi.fn(async () => ({
        id: newMediaId, filename: staged.output.filename, kind: "image",
        mimeType: "image/webp", size: staged.output.bytes, url: "https://cdn.test/new",
        status: "ready", version: 1, createdAt: "2026-07-13T00:00:00.000Z",
        width: null, height: null, posterMediaId: null,
      })),
      update: vi.fn(async (_id, update) => {
        const file = {
          id: newMediaId, filename: staged.output.filename, kind: "image",
          mimeType: "image/webp", size: staged.output.bytes, url: "https://cdn.test/new",
          status: "ready", version: 2, createdAt: "2026-07-13T00:00:00.000Z",
          width: update.width, height: update.height, altText: update.altText, posterMediaId: null,
        };
        remoteMedia.push(file);
        return file;
      }),
    };
    const state = () => ({
      capturedAt: "2026-07-13T00:00:00.000Z",
      media: remoteMedia,
      retainedDetails: [{
        id: retainedId,
        slug: "retained",
        media: [{ id: "pmed_old_primary", mediaId: old.id, status: "ready", posterMediaId: null }],
      }],
    });
    const hashRemote = vi.fn();
    const result = await runMediaUploadBridge({
      manifest,
      ...input,
      readClient: {},
      mediaClient,
      readState: vi.fn(async () => state()),
      hashRemote,
      now: () => new Date("2026-07-13T01:00:00.000Z"),
      requiredAssetCount: 1,
    });
    expect(result.summary).toMatchObject({ total: 1, uploaded: 1, reused: 0 });
    expect(hashRemote).not.toHaveBeenCalled();
    expect(result.report.assets[0]).toMatchObject({
      logicalKey,
      mediaId: newMediaId,
      retainedReplacement: { productId: retainedId, mediaId: oldMediaId },
    });
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
