import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertCompleteRemoteMediaReadiness, snapshotAuthorityFingerprint } from "./verification.mjs";
import { assertApplyExclusions, assertApplyPermissions, requiredPermissionsForLifecycle } from "./preflight.mjs";
import {
  appendPrivateResumeRecord,
  preparePrivateApplyPaths,
  readPrivateApplyJson,
  readPrivateResumeRecords,
} from "./private-state.mjs";
import { buildExpectedAssets } from "../assets/expected-assets.mjs";
import { ASSET_PROFILES } from "../assets/profiles.mjs";
import { manifestReadinessFingerprint } from "../apply-readiness.mjs";
import { demoStoreManifest } from "../manifest.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function lifecycle(commands) {
  return { phases: [{ name: "write", state: "ready", commands, blockers: [] }] };
}

function completeRemoteReadiness() {
  const expected = buildExpectedAssets(demoStoreManifest);
  const byOwner = new Map();
  for (const asset of expected) {
    const owner = byOwner.get(asset.owner) ?? [];
    owner.push(asset);
    byOwner.set(asset.owner, owner);
  }
  const assets = expected.map((asset, index) => {
    const profile = ASSET_PROFILES[asset.profile];
    const poster = asset.kind === "video"
      ? byOwner.get(asset.owner).find((candidate) => candidate.role.startsWith("poster"))
      : null;
    return {
      logicalKey: asset.logicalKey,
      mediaId: `media_remote_${String(index).padStart(4, "0")}`,
      status: "ready",
      kind: asset.kind,
      sha256: index.toString(16).padStart(64, "0"),
      url: `https://media.example.test/demo-${index}.${asset.kind === "video" ? "mp4" : "webp"}`,
      filename: `demo-${index}.${asset.kind === "video" ? "mp4" : "webp"}`,
      size: 100_000 + index,
      createdAt: "2026-07-14T01:00:00.000Z",
      width: asset.kind === "video" ? 1920 : profile.width,
      height: asset.kind === "video" ? 1080 : profile.height,
      importAction: "uploaded",
      ...(poster ? {
        posterLogicalKey: poster.logicalKey,
        posterMediaId: `media_remote_${String(expected.indexOf(poster)).padStart(4, "0")}`,
      } : {}),
    };
  });
  return {
    schemaVersion: 1,
    status: "complete",
    verifiedAt: "2026-07-14T01:00:00.000Z",
    manifestFingerprint: manifestReadinessFingerprint(demoStoreManifest),
    assets,
    unversionedSettings: [],
    presentation: {},
    evidence: {
      productsMutated: false,
      publicationMutated: false,
      uploadOrder: "sequential",
      posterLinksVerified: assets.filter((asset) => asset.kind === "video").length,
    },
  };
}

describe("demo apply permission and exclusion preflight", () => {
  it("derives every write permission from the exact planned commands", () => {
    const plan = lifecycle([
      { method: "POST", path: "/api/v1/admin/attributes" },
      { method: "POST", path: "/api/v1/admin/categories" },
      { method: "PATCH", path: "/api/v1/admin/categories/{categoryId}/status" },
      { method: "POST", path: "/api/v1/admin/products" },
      { method: "PUT", path: "/api/v1/admin/products/{productId}/options/matrix" },
      { method: "POST", path: "/api/v1/admin/collections" },
      { method: "PUT", path: "/api/v1/admin/collections/col_1" },
      { method: "POST", path: "/api/v1/admin/settings/hero-sliders" },
    ]);
    const required = requiredPermissionsForLifecycle(plan);
    expect(required).toEqual([
      "attributes.create", "categories.create", "categories.edit", "collections.create",
      "collections.edit", "products.create", "products.edit", "settings.header.edit",
    ]);
    expect(() => assertApplyPermissions({ isSuperAdmin: false, permissions: required.slice(1) }, plan))
      .toThrow("attributes.create");
    expect(assertApplyPermissions({ isSuperAdmin: true, permissions: [] }, plan).required).toEqual(required);
  });

  it("fails closed on unknown mutations and unrevisioned publication intent", () => {
    expect(() => requiredPermissionsForLifecycle(lifecycle([{ method: "DELETE", path: "/api/v1/admin/products/prod_1" }])))
      .toThrow("No permission preflight rule");
    expect(() => assertApplyExclusions({ publicationIntent: { navigation: { header: {} } } }))
      .toThrow("Header/footer publication");
    expect(() => assertApplyExclusions({ publicationIntent: { promotions: [{ code: "DEMO" }] } }))
      .toThrow("Standalone promotion");
    expect(() => assertApplyExclusions({ readinessReport: { presentation: { footer: {} } } }))
      .toThrow("must not contain header/footer");
  });
});

describe("complete remote Media apply authority", () => {
  it("matches every readiness identity and video poster against a fresh remote projection", () => {
    const report = completeRemoteReadiness();
    const media = report.assets.map((asset) => ({
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
    expect(assertCompleteRemoteMediaReadiness(demoStoreManifest, report, { media }).assets.size).toBe(237);
    media[0].url = "https://media.example.test/drifted.webp";
    expect(() => assertCompleteRemoteMediaReadiness(demoStoreManifest, report, { media }))
      .toThrow("fresh remote Media projection");
  });

  it("fingerprints authority while excluding only capture metadata", () => {
    const left = { capturedAt: "2026-07-14T01:00:00.000Z", auth: { authenticated: true }, products: [{ id: "p1", revision: 1 }] };
    const right = { ...left, capturedAt: "2026-07-14T01:01:00.000Z" };
    expect(snapshotAuthorityFingerprint(left)).toBe(snapshotAuthorityFingerprint(right));
    expect(snapshotAuthorityFingerprint(left)).not.toBe(snapshotAuthorityFingerprint({ ...right, products: [{ id: "p1", revision: 2 }] }));
  });
});

describe("private apply evidence and resume paths", () => {
  it("keeps inputs and resumable state under a private workspace .wrangler boundary", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "scalius-demo-apply-"));
    temporaryDirectories.push(workspace);
    const fingerprint = "a".repeat(64);
    const paths = await preparePrivateApplyPaths({ workspaceDir: workspace, intentFingerprint: fingerprint });
    const reportPath = path.join(workspace, ".wrangler", "remote-readiness.json");
    await writeFile(reportPath, "{\"status\":\"complete\"}\n", { mode: 0o600 });
    expect(await readPrivateApplyJson(reportPath, { workspaceDir: workspace })).toEqual({ status: "complete" });
    const record = { schemaVersion: 2, intentFingerprint: fingerprint, phase: "phase", logicalKey: "resource", status: "applied", authority: { id: "resource_1" }, timestamp: "2026-07-14T01:00:00.000Z" };
    await appendPrivateResumeRecord(paths.resumeFile, record);
    expect(await readPrivateResumeRecords(paths.resumeFile)).toEqual([record]);
    expect((await stat(paths.resumeFile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.evidenceDir)).mode & 0o777).toBe(0o700);

    const publicPath = path.join(workspace, "readiness.json");
    await writeFile(publicPath, "{}", { mode: 0o600 });
    await expect(readPrivateApplyJson(publicPath, { workspaceDir: workspace })).rejects.toThrow("workspace .wrangler");
    await chmod(reportPath, 0o644);
    await expect(readPrivateApplyJson(reportPath, { workspaceDir: workspace })).rejects.toThrow("exclude group and other");
  });
});
