import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main as retainedExportMain, parseRetainedExportArgs } from "./retained-export-cli.mjs";
import {
  RETAINED_MEDIA_EXPORT_ALLOWLIST,
  runRetainedMediaExport,
  validatePrivateSourceDirectoryPath,
  validateRetainedExportAuthority,
} from "./retained-export.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const authority = { schemaVersion: 1, mediaOrigin: "https://cdn.test", assets: [] };
  const media = [];
  const bytesByUrl = new Map();
  const details = new Map();
  for (const [index, item] of RETAINED_MEDIA_EXPORT_ALLOWLIST.entries()) {
    const mediaId = `media_retained_${String(index + 1).padStart(2, "0")}`;
    const mimeType = item.kind === "video" ? "video/mp4" : "image/png";
    const bytes = Buffer.from(`exact-current-bytes:${item.logicalKey}`);
    const url = `https://cdn.test/${mediaId}`;
    authority.assets.push({ logicalKey: item.logicalKey, mediaId });
    media.push({ id: mediaId, filename: `${item.role}.${item.kind === "video" ? "mp4" : "png"}`, kind: item.kind, mimeType, size: bytes.length, width: 1280, height: 720, status: "ready", version: 3, createdAt: "2026-07-13T00:00:00.000Z", url, posterMediaId: null });
    bytesByUrl.set(url, bytes);
    if (!details.has(item.productId)) details.set(item.productId, { id: item.productId, slug: item.slug, media: [], variants: [] });
    if (item.association === "direct") details.get(item.productId).media.push({ id: `association_${index + 1}`, mediaId, status: "ready", posterMediaId: null, isPrimary: item.role === "primary" });
  }
  const videoAuthority = authority.assets.find((item) => item.logicalKey === "halo-arc-table-lamp:video");
  const posterAuthority = authority.assets.find((item) => item.logicalKey === "halo-arc-table-lamp:poster");
  const haloProductId = RETAINED_MEDIA_EXPORT_ALLOWLIST.find((item) => item.logicalKey === "halo-arc-table-lamp:video").productId;
  media.find((item) => item.id === videoAuthority.mediaId).posterMediaId = posterAuthority.mediaId;
  details.get(haloProductId).media.find((item) => item.mediaId === videoAuthority.mediaId).posterMediaId = posterAuthority.mediaId;
  const riderSand = authority.assets.find((item) => item.logicalKey === "rider-court-trainers:variant-sand");
  const rider = details.get(RETAINED_MEDIA_EXPORT_ALLOWLIST[0].productId);
  const sandAssociation = rider.media.find((item) => item.mediaId === riderSand.mediaId);
  rider.variants = ["40", "41", "42"].map((size) => ({ id: `rider_${size}_sand`, imageId: sandAssociation.id, selectedOptions: [{ name: "Size", value: size }, { name: "Color", value: "Sand" }] }));
  return { authority, bytesByUrl, state: { capturedAt: "2026-07-13T00:00:00.000Z", media, retainedDetails: [...details.values()] } };
}

describe("retained Media read-only export", () => {
  it("downloads exact Rider/Halo authority sequentially and emits private unapproved provenance", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scalius-retained-export-"));
    directories.push(directory);
    const sourceDir = path.join(directory, ".wrangler", "retained-sources");
    const input = fixture();
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      requests.push({ url: String(url), method: init.method, redirect: init.redirect, headers: init.headers });
      const bytes = input.bytesByUrl.get(String(url));
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length), "content-type": String(url).includes("media_retained_06") ? "video/mp4" : "image/png" } });
    });
    const inspectAsset = vi.fn(async (filePath) => {
      const bytes = await readFile(filePath);
      const media = input.state.media.find((item) => input.bytesByUrl.get(item.url).equals(bytes));
      return { kind: media.kind, mime: media.mimeType, bytes, width: media.width, height: media.height, sha256: sha256(bytes) };
    });
    const readState = vi.fn(async () => structuredClone(input.state));
    const result = await runRetainedMediaExport({ authority: input.authority, manifest: {}, sourceDir, workspaceDir: directory, readClient: {}, readState, fetchImpl, inspectAsset, now: () => new Date("2026-07-13T05:00:00.000Z") });

    expect(readState).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(8);
    expect(requests.every((request) => request.method === "GET" && request.redirect === "manual")).toBe(true);
    expect(requests.every((request) => !request.headers.cookie && !request.headers.authorization)).toBe(true);
    expect(result.summary).toEqual({ exported: 8, ownershipReviewRequired: 8, videoPosterPairs: 1 });
    expect(result.candidate.status).toBe("unapproved");
    expect(result.candidate.evidence).toMatchObject({ adminResourceMutations: 0, mediaMutations: 0, productMutations: 0, publicationMutations: 0, downloadOrder: "sequential" });
    expect(result.candidate.assets.every((asset) => asset.status === "unapproved" && asset.sourceKind === "merchant-owned" && asset.merchantOwnershipReference === null && asset.rightsReview.reviewedBy === null)).toBe(true);
    expect(result.candidate.assets.find((asset) => asset.logicalKey === "halo-arc-table-lamp:video").remoteEvidence).toMatchObject({ posterLogicalKey: "halo-arc-table-lamp:poster", posterMediaId: input.authority.assets.find((item) => item.logicalKey === "halo-arc-table-lamp:poster").mediaId });
    expect((await stat(sourceDir)).mode & 0o077).toBe(0);
    expect((await stat(result.candidatePath)).mode & 0o077).toBe(0);
    for (const asset of result.candidate.assets) expect((await stat(path.join(sourceDir, asset.sourceFile))).mode & 0o077).toBe(0);
  });

  it("rejects an off-origin redirect without following it or writing provenance", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scalius-retained-export-"));
    directories.push(directory);
    const input = fixture();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://attacker.test/stolen" } }));
    await expect(runRetainedMediaExport({ authority: input.authority, manifest: {}, sourceDir: path.join(directory, ".wrangler", "retained-sources"), workspaceDir: directory, readClient: {}, readState: vi.fn(async () => input.state), fetchImpl, inspectAsset: vi.fn() })).rejects.toThrow("off-origin redirect");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("publishes no files when the fresh post-download snapshot changes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scalius-retained-export-"));
    directories.push(directory);
    const sourceDir = path.join(directory, ".wrangler", "retained-sources");
    const input = fixture();
    const changed = structuredClone(input.state);
    changed.media[0].version += 1;
    let reads = 0;
    const readState = vi.fn(async () => structuredClone(reads++ === 0 ? input.state : changed));
    const fetchImpl = vi.fn(async (url) => {
      const bytes = input.bytesByUrl.get(String(url));
      const file = input.state.media.find((item) => item.url === String(url));
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length), "content-type": file.mimeType } });
    });
    const inspectAsset = vi.fn(async (filePath) => {
      const bytes = await readFile(filePath);
      const file = input.state.media.find((item) => input.bytesByUrl.get(item.url).equals(bytes));
      return { kind: file.kind, mime: file.mimeType, bytes, width: file.width, height: file.height, sha256: sha256(bytes) };
    });
    await expect(runRetainedMediaExport({ authority: input.authority, manifest: {}, sourceDir, workspaceDir: directory, readClient: {}, readState, fetchImpl, inspectAsset })).rejects.toThrow("changed during export");
    expect(await readdir(sourceDir)).toEqual([]);
  });

  it("requires every exact allowlisted logical key and current Media association", () => {
    const input = fixture();
    input.authority.assets.pop();
    expect(() => validateRetainedExportAuthority(input.authority, input.state)).toThrow("exactly the eight allowlisted");
    const changed = fixture();
    changed.authority.assets[0].mediaId = "media_unknown_99";
    expect(() => validateRetainedExportAuthority(changed.authority, changed.state)).toThrow("not current");
  });

  it("requires explicit local-write authorization and rejects credential arguments", () => {
    expect(() => parseRetainedExportArgs([])).toThrow("--export-retained");
    for (const argument of ["--email=x@example.com", "--username=x", "--password=x", "--cookie=x", "--token=x", "--secret=x", "--authorization=x", "--api-key=x", "--session=x"]) expect(() => parseRetainedExportArgs([argument])).toThrow("interactive prompt");
    expect(() => validatePrivateSourceDirectoryPath("/tmp/outside", "/workspace/project")).toThrow("workspace .wrangler");
    expect(() => parseRetainedExportArgs(["--unknown=do-not-echo-me"])).toThrow(/^Unknown argument\./u);
    try { parseRetainedExportArgs(["--unknown=do-not-echo-me"]); } catch (error) { expect(error.message).not.toContain("do-not-echo-me"); }
  });

  it("rejects structurally incomplete authority before prompting for credentials", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scalius-retained-export-"));
    directories.push(directory);
    const privateDir = path.join(directory, ".wrangler", "retained-sources");
    await mkdir(path.dirname(privateDir), { recursive: true });
    const authorityPath = path.join(directory, ".wrangler", "authority.json");
    await writeFile(authorityPath, JSON.stringify({ schemaVersion: 1, mediaOrigin: "https://cdn.test", assets: [] }));
    const credentialReader = vi.fn();
    await expect(retainedExportMain(["--export-retained", "--authority", authorityPath, "--source-dir", privateDir], { credentialReader, workspaceDir: directory })).rejects.toThrow("exactly the eight allowlisted");
    expect(credentialReader).not.toHaveBeenCalled();
  });

  it("does not import a Media, apply, product, or publication mutation client", async () => {
    const [runnerSource, cliSource] = await Promise.all([
      readFile(new URL("./retained-export.mjs", import.meta.url), "utf8"),
      readFile(new URL("./retained-export-cli.mjs", import.meta.url), "utf8"),
    ]);
    for (const source of [runnerSource, cliSource]) {
      expect(source).not.toMatch(/createMediaUploadClient|apply-client|run-apply|mediaClient|productClient|publicationClient/u);
    }
  });
});
