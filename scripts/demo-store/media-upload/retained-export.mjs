import { createHash } from "node:crypto";
import { open, link, lstat, mkdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { inspectLocalAsset } from "../assets/inspect-local-asset.mjs";
import { IMAGE_MIME_LIMIT_BYTES, VIDEO_MIME_LIMIT_BYTES } from "../assets/profiles.mjs";
import { readFreshMediaState } from "./remote.mjs";

export const RETAINED_MEDIA_EXPORT_ALLOWLIST = Object.freeze([
  { logicalKey: "rider-court-trainers:primary", productId: "prod_9XNNERD2XpAOIoI1SN6gx", slug: "rider-court-trainers", role: "primary", kind: "image", association: "direct" },
  { logicalKey: "rider-court-trainers:variant-sand", productId: "prod_9XNNERD2XpAOIoI1SN6gx", slug: "rider-court-trainers", role: "variant-sand", kind: "image", association: "direct" },
  { logicalKey: "rider-court-trainers:detail", productId: "prod_9XNNERD2XpAOIoI1SN6gx", slug: "rider-court-trainers", role: "detail", kind: "image", association: "direct" },
  { logicalKey: "rider-court-trainers:lifestyle", productId: "prod_9XNNERD2XpAOIoI1SN6gx", slug: "rider-court-trainers", role: "lifestyle", kind: "image", association: "direct" },
  { logicalKey: "halo-arc-table-lamp:primary", productId: "prod_FOHvuxr0Hr11AA_hyLUpH", slug: "halo-arc-table-lamp", role: "primary", kind: "image", association: "direct" },
  { logicalKey: "halo-arc-table-lamp:video", productId: "prod_FOHvuxr0Hr11AA_hyLUpH", slug: "halo-arc-table-lamp", role: "video", kind: "video", association: "direct", posterLogicalKey: "halo-arc-table-lamp:poster" },
  { logicalKey: "halo-arc-table-lamp:poster", productId: "prod_FOHvuxr0Hr11AA_hyLUpH", slug: "halo-arc-table-lamp", role: "poster", kind: "image", association: "poster", posterForLogicalKey: "halo-arc-table-lamp:video" },
  { logicalKey: "halo-arc-table-lamp:detail", productId: "prod_FOHvuxr0Hr11AA_hyLUpH", slug: "halo-arc-table-lamp", role: "detail", kind: "image", association: "direct" },
]);

const MEDIA_ID = /^[A-Za-z0-9_-]{8,160}$/u;
const MIME_EXTENSION = Object.freeze({
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif",
  "video/mp4": "mp4", "video/webm": "webm",
});

function exactMap(rows, field, label) {
  const result = new Map();
  for (const row of rows ?? []) {
    const value = row?.[field];
    if (!value || result.has(value)) throw new Error(`${label} has a missing or duplicate ${field}.`);
    result.set(value, row);
  }
  return result;
}

function sameSet(actual, expected) {
  return actual.size === expected.size && [...actual].every((value) => expected.has(value));
}

export function validateRetainedExportAuthorityShape(authority) {
  if (authority?.schemaVersion !== 1 || !Array.isArray(authority?.assets) || typeof authority?.mediaOrigin !== "string") {
    throw new Error("Retained Media authority must use schemaVersion 1, one pinned mediaOrigin, and an assets array.");
  }
  if (!sameSet(new Set(Object.keys(authority)), new Set(["schemaVersion", "mediaOrigin", "assets"]))) throw new Error("Retained Media authority contains unsupported fields.");
  let mediaOrigin;
  try { mediaOrigin = new URL(authority.mediaOrigin); } catch { throw new Error("Retained Media authority mediaOrigin is invalid."); }
  if (mediaOrigin.protocol !== "https:" || mediaOrigin.origin !== authority.mediaOrigin || mediaOrigin.username || mediaOrigin.password) throw new Error("Retained Media authority mediaOrigin must be one credential-free HTTPS origin.");
  const allowlist = exactMap(RETAINED_MEDIA_EXPORT_ALLOWLIST, "logicalKey", "Retained Media allowlist");
  const supplied = exactMap(authority.assets, "logicalKey", "Retained Media authority");
  if (!sameSet(new Set(supplied.keys()), new Set(allowlist.keys()))) {
    throw new Error("Retained Media authority must contain exactly the eight allowlisted Rider/Halo logical keys.");
  }
  const selectedIds = new Set();
  for (const item of RETAINED_MEDIA_EXPORT_ALLOWLIST) {
    const requested = supplied.get(item.logicalKey);
    if (!sameSet(new Set(Object.keys(requested)), new Set(["logicalKey", "mediaId"]))) throw new Error(`${item.logicalKey} authority accepts only logicalKey and mediaId.`);
    if (!MEDIA_ID.test(requested.mediaId ?? "") || selectedIds.has(requested.mediaId)) throw new Error(`${item.logicalKey} must name one unique current Media ID.`);
    selectedIds.add(requested.mediaId);
  }
  return { mediaOrigin, supplied };
}

export function validateRetainedExportAuthority(authority, state) {
  const { mediaOrigin, supplied } = validateRetainedExportAuthorityShape(authority);
  const mediaById = exactMap(state?.media, "id", "Fresh ready Media");
  const detailsById = exactMap(state?.retainedDetails, "id", "Fresh retained product details");
  const records = [];

  for (const item of RETAINED_MEDIA_EXPORT_ALLOWLIST) {
    const requested = supplied.get(item.logicalKey);
    const detail = detailsById.get(item.productId);
    if (!detail || detail.slug !== item.slug) throw new Error(`${item.logicalKey} retained product identity changed.`);
    const directIds = new Set((detail.media ?? []).filter((entry) => entry.status === "ready").map((entry) => entry.mediaId));
    const posterIds = new Set((detail.media ?? []).filter((entry) => entry.status === "ready").map((entry) => entry.posterMediaId).filter(Boolean));
    const associationIds = item.association === "poster" ? posterIds : directIds;
    if (!associationIds.has(requested.mediaId)) throw new Error(`${item.logicalKey} Media ID is not current in its required ${item.association} association.`);
    const file = mediaById.get(requested.mediaId);
    if (!file || file.status !== "ready" || file.kind !== item.kind) throw new Error(`${item.logicalKey} does not resolve to ready ${item.kind} Media.`);
    if (!MIME_EXTENSION[file.mimeType] || !file.mimeType.startsWith(`${item.kind}/`) || !Number.isSafeInteger(file.size) || file.size <= 0 || !Number.isSafeInteger(file.width) || file.width <= 0 || !Number.isSafeInteger(file.height) || file.height <= 0 || !Number.isSafeInteger(file.version) || file.version < 1) {
      throw new Error(`${item.logicalKey} Media projection lacks verifiable MIME, size, or dimensions.`);
    }
    if (typeof file.filename !== "string" || !file.filename.trim() || file.filename.length > 255 || /[\r\n]/u.test(file.filename)) throw new Error(`${item.logicalKey} Media filename is unsafe.`);
    let fileUrl;
    try { fileUrl = new URL(file.url); } catch { throw new Error(`${item.logicalKey} Media URL is invalid.`); }
    if (fileUrl.origin !== mediaOrigin.origin || fileUrl.protocol !== "https:" || fileUrl.username || fileUrl.password || fileUrl.hash) throw new Error(`${item.logicalKey} Media URL is outside the pinned origin or contains unsafe URL material.`);
    const limit = item.kind === "video" ? VIDEO_MIME_LIMIT_BYTES : IMAGE_MIME_LIMIT_BYTES;
    if (file.size > limit) throw new Error(`${item.logicalKey} exceeds the bounded ${item.kind} export size.`);
    records.push({ ...item, mediaId: requested.mediaId, file });
  }

  for (const primary of records.filter((item) => item.role === "primary")) {
    const detail = detailsById.get(primary.productId);
    const association = (detail.media ?? []).find((entry) => entry.mediaId === primary.mediaId);
    if (!association?.isPrimary) throw new Error(`${primary.logicalKey} is not the current primary product association.`);
  }
  const riderSand = records.find((item) => item.logicalKey === "rider-court-trainers:variant-sand");
  const riderDetail = detailsById.get(riderSand.productId);
  const sandAssociation = (riderDetail.media ?? []).find((entry) => entry.mediaId === riderSand.mediaId);
  const sandVariants = (riderDetail.variants ?? []).filter((variant) => (variant.selectedOptions ?? []).some((option) => option.value === "Sand"));
  if (!sandAssociation?.id || sandVariants.length === 0 || sandVariants.some((variant) => variant.imageId !== sandAssociation.id)) {
    throw new Error("Rider Sand SKU image binding does not match the exact retained association.");
  }

  for (const product of new Map(RETAINED_MEDIA_EXPORT_ALLOWLIST.map((item) => [item.productId, item])).values()) {
    const detail = detailsById.get(product.productId);
    const expectedDirect = new Set(records.filter((item) => item.productId === product.productId && item.association === "direct").map((item) => item.mediaId));
    const actualDirect = new Set((detail.media ?? []).filter((entry) => entry.status === "ready").map((entry) => entry.mediaId));
    const expectedPosters = new Set(records.filter((item) => item.productId === product.productId && item.association === "poster").map((item) => item.mediaId));
    const actualPosters = new Set((detail.media ?? []).filter((entry) => entry.status === "ready").map((entry) => entry.posterMediaId).filter(Boolean));
    if (!sameSet(actualDirect, expectedDirect) || !sameSet(actualPosters, expectedPosters)) {
      throw new Error(`${product.slug} current Media associations do not exactly match the allowlisted authority.`);
    }
  }

  const video = records.find((item) => item.logicalKey === "halo-arc-table-lamp:video");
  const poster = records.find((item) => item.logicalKey === "halo-arc-table-lamp:poster");
  const haloDetail = detailsById.get(video.productId);
  const haloVideoAssociation = (haloDetail.media ?? []).find((entry) => entry.mediaId === video.mediaId);
  if (video.file.posterMediaId !== poster.mediaId || haloVideoAssociation?.posterMediaId !== poster.mediaId) {
    throw new Error("Halo video and poster do not have the exact current poster relationship.");
  }
  return records;
}

function safeStem(logicalKey) {
  return logicalKey.replace(/[^a-zA-Z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").toLowerCase();
}

export function validatePrivateSourceDirectoryPath(sourceDir, workspaceDir = process.cwd()) {
  const privateRoot = path.resolve(workspaceDir, ".wrangler");
  const resolvedSource = path.resolve(sourceDir);
  const relative = path.relative(privateRoot, resolvedSource);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Retained Media source directory must be a child of the workspace .wrangler directory.");
  return { privateRoot, resolvedSource };
}

async function preparePrivateDirectory(sourceDir, workspaceDir) {
  const { privateRoot, resolvedSource } = validatePrivateSourceDirectoryPath(sourceDir, workspaceDir);
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(privateRoot);
  let nearest = resolvedSource;
  while (true) {
    try { await lstat(nearest); break; } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(nearest);
      if (parent === nearest) throw new Error("Retained Media source directory has no safe existing ancestor.", { cause: error });
      nearest = parent;
    }
  }
  const realNearest = await realpath(nearest);
  const nearestRelative = path.relative(realRoot, realNearest);
  if (nearestRelative.startsWith("..") || path.isAbsolute(nearestRelative)) throw new Error("Retained Media source directory traverses a symlink outside .wrangler.");
  await mkdir(resolvedSource, { recursive: true, mode: 0o700 });
  const [sourceLinkInfo, realSource] = await Promise.all([lstat(resolvedSource), realpath(resolvedSource)]);
  const realRelative = path.relative(realRoot, realSource);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("Retained Media source directory resolves outside the workspace .wrangler directory.");
  const directoryInfo = await stat(realSource);
  if (!directoryInfo.isDirectory() || sourceLinkInfo.isSymbolicLink()) throw new Error("Retained Media source directory must be a real private directory.");
  if ((directoryInfo.mode & 0o077) !== 0) throw new Error("Retained Media source directory permissions must exclude group and other access.");
  return realSource;
}

function normalizedMime(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

async function responseForMedia(file, { fetchImpl, timeoutMs, maxRedirects = 3 }) {
  let current;
  try { current = new URL(file.url); } catch { throw new Error("Remote Media URL is invalid."); }
  if (current.protocol !== "https:" || current.username || current.password) throw new Error("Remote Media URL must be credential-free HTTPS.");
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetchImpl(current, {
      method: "GET",
      headers: { accept: file.mimeType, "accept-encoding": "identity" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (redirects === maxRedirects) throw new Error("Remote Media exceeded the same-origin redirect limit.");
      const location = response.headers.get("location");
      if (!location) throw new Error("Remote Media redirect has no location.");
      const next = new URL(location, current);
      if (next.origin !== current.origin || next.protocol !== "https:" || next.username || next.password) {
        throw new Error("Remote Media attempted an off-origin redirect.");
      }
      current = next;
      continue;
    }
    return response;
  }
  throw new Error("Remote Media redirect verification failed.");
}

async function downloadVerified(record, sourceDir, { fetchImpl, timeoutMs, inspectAsset }) {
  const response = await responseForMedia(record.file, { fetchImpl, timeoutMs });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(`${record.logicalKey} download failed with HTTP ${response.status}.`);
  }
  const declaredLength = response.headers.get("content-length");
  if (!/^\d+$/u.test(declaredLength ?? "") || Number(declaredLength) !== record.file.size) {
    await response.body.cancel();
    throw new Error(`${record.logicalKey} response Content-Length does not match current Media.`);
  }
  if (normalizedMime(response.headers.get("content-type")) !== record.file.mimeType) {
    await response.body.cancel();
    throw new Error(`${record.logicalKey} response MIME does not match current Media.`);
  }
  const contentEncoding = normalizedMime(response.headers.get("content-encoding"));
  if (contentEncoding && contentEncoding !== "identity") {
    await response.body.cancel();
    throw new Error(`${record.logicalKey} response Content-Encoding must be identity.`);
  }
  const extension = MIME_EXTENSION[record.file.mimeType];
  const temporaryPath = path.join(sourceDir, `.${safeStem(record.logicalKey)}-${process.pid}-${Date.now()}.partial`);
  const handle = await open(temporaryPath, "wx", 0o600);
  const digest = createHash("sha256");
  let received = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > record.file.size) {
        await reader.cancel();
        throw new Error(`${record.logicalKey} exceeded its declared Media size.`);
      }
      digest.update(value);
      await handle.write(value);
    }
  } catch (error) {
    await handle.close();
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  await handle.close();
  if (received !== record.file.size) {
    await unlink(temporaryPath).catch(() => {});
    throw new Error(`${record.logicalKey} downloaded byte size does not match current Media.`);
  }
  const sha256 = digest.digest("hex");
  const inspected = await inspectAsset(temporaryPath);
  const inspectedBytes = Buffer.isBuffer(inspected.bytes) ? inspected.bytes.length : inspected.bytes;
  if (inspected.kind !== record.kind || inspected.mime !== record.file.mimeType || inspectedBytes !== record.file.size || inspected.sha256 !== sha256 || inspected.width !== record.file.width || inspected.height !== record.file.height) {
    await unlink(temporaryPath).catch(() => {});
    throw new Error(`${record.logicalKey} downloaded bytes do not match current Media MIME, size, hash, and dimensions.`);
  }
  const filename = `${safeStem(record.logicalKey)}--${sha256.slice(0, 12)}.${extension}`;
  const finalPath = path.join(sourceDir, filename);
  try {
    await link(temporaryPath, finalPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  return { filename, filePath: finalPath, sha256, kind: inspected.kind, mime: inspected.mime, bytes: inspectedBytes, width: inspected.width, height: inspected.height };
}

function snapshotFingerprint(records) {
  return createHash("sha256").update(JSON.stringify(records.map((record) => ({
    logicalKey: record.logicalKey,
    productId: record.productId,
    mediaId: record.mediaId,
    version: record.file.version,
    url: record.file.url,
    mimeType: record.file.mimeType,
    size: record.file.size,
    width: record.file.width,
    height: record.file.height,
    posterMediaId: record.file.posterMediaId ?? null,
  })))).digest("hex");
}

async function writeCandidate(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  const info = await stat(filePath);
  if ((info.mode & 0o077) !== 0) {
    await unlink(filePath).catch(() => {});
    throw new Error("Provenance candidate permissions are not private.");
  }
}

export async function runRetainedMediaExport({
  authority,
  manifest,
  sourceDir,
  workspaceDir = process.cwd(),
  readClient,
  readState = readFreshMediaState,
  fetchImpl = fetch,
  inspectAsset = inspectLocalAsset,
  timeoutMs = 30_000,
  now = () => new Date(),
}) {
  const privateSourceDir = await preparePrivateDirectory(sourceDir, workspaceDir);
  const candidatePath = path.join(privateSourceDir, "provenance-candidate.json");
  try {
    await lstat(candidatePath);
    throw new Error("Provenance candidate already exists; retained export never overwrites evidence.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const batchDir = path.join(privateSourceDir, `.retained-export-${process.pid}-${Date.now()}`);
  await mkdir(batchDir, { mode: 0o700 });
  try {
    const before = validateRetainedExportAuthority(authority, await readState(readClient, manifest));
    const beforeFingerprint = snapshotFingerprint(before);
    const exported = [];
    for (const record of before) {
      const local = await downloadVerified(record, batchDir, { fetchImpl, timeoutMs, inspectAsset });
      exported.push({ record, local });
    }
    const after = validateRetainedExportAuthority(authority, await readState(readClient, manifest));
    const afterFingerprint = snapshotFingerprint(after);
    if (afterFingerprint !== beforeFingerprint) throw new Error("Retained Media changed during export; provenance candidate was not written.");

    const exportedAt = now().toISOString();
    const byLogicalKey = new Map(exported.map((item) => [item.record.logicalKey, item]));
    const candidate = {
      schemaVersion: 1,
      kind: "retained-media-provenance-candidates",
      status: "unapproved",
      exportedAt,
      snapshot: { before: beforeFingerprint, after: afterFingerprint, freshReads: 2 },
      evidence: { adminResourceMutations: 0, mediaMutations: 0, productMutations: 0, publicationMutations: 0, downloadOrder: "sequential" },
      assets: exported.map(({ record, local }) => ({
        logicalKey: record.logicalKey,
        status: "unapproved",
        sourceKind: "merchant-owned",
        sourceFile: local.filename,
        creator: null,
        license: { code: "Proprietary-Merchant-Owned", url: null, attribution: "" },
        merchantOwnershipReference: null,
        acquiredAt: null,
        verifiedAt: null,
        sha256: local.sha256,
        original: { mime: local.mime, bytes: local.bytes, width: local.width, height: local.height },
        cropPosition: "centre",
        rightsReview: {
          reviewedBy: null,
          noWatermark: false,
          noVisibleBranding: false,
          noTrademarkedCharacter: false,
          noIdentifiableEndorser: false,
          optionAppearanceVerified: false,
        },
        remoteReuse: { productId: record.productId, mediaId: record.mediaId },
        remoteEvidence: {
          productId: record.productId,
          mediaId: record.mediaId,
          mediaVersion: record.file.version,
          mediaFilename: record.file.filename,
          mediaOrigin: new URL(record.file.url).origin,
          association: record.association,
          ...(record.posterLogicalKey ? {
            posterLogicalKey: record.posterLogicalKey,
            posterMediaId: byLogicalKey.get(record.posterLogicalKey).record.mediaId,
          } : {}),
          ...(record.posterForLogicalKey ? {
            posterForLogicalKey: record.posterForLogicalKey,
            videoMediaId: byLogicalKey.get(record.posterForLogicalKey).record.mediaId,
          } : {}),
        },
      })),
    };
    const publishedPaths = [];
    try {
      for (const { local } of exported) {
        const destination = path.join(privateSourceDir, local.filename);
        await link(local.filePath, destination);
        publishedPaths.push(destination);
      }
      await writeCandidate(candidatePath, candidate);
    } catch (error) {
      await Promise.all(publishedPaths.map((filePath) => unlink(filePath).catch(() => {})));
      throw error;
    }
    return { candidate, candidatePath, sourceDir: privateSourceDir, summary: { exported: exported.length, ownershipReviewRequired: exported.length, videoPosterPairs: 1 } };
  } finally {
    await rm(batchDir, { recursive: true, force: true });
  }
}
