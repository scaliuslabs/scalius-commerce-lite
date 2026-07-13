import { open, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateStagedAssetReadiness, manifestReadinessFingerprint } from "../apply-readiness.mjs";
import { appendUploadJournal, readUploadJournal } from "./journal.mjs";
import { hashRemoteMedia, readFreshMediaState } from "./remote.mjs";
import { validateCompleteStagedInputs } from "./validate.mjs";

const MAX_PART_BYTES = 5 * 1024 * 1024;
const MAX_PARTS = 20;

function exactMap(rows, field, label) {
  const result = new Map();
  for (const row of rows ?? []) {
    if (!row?.[field] || result.has(row[field])) throw new Error(`${label} has a missing or duplicate ${field}.`);
    result.set(row[field], row);
  }
  return result;
}

function isoTimestamp(value) {
  const date = typeof value === "number"
    ? new Date(value < 10_000_000_000 ? value * 1_000 : value)
    : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Remote Media has an invalid creation timestamp.");
  return date.toISOString();
}

function assertRemoteShape(file, entry, { reused = false } = {}) {
  const expectedSize = reused ? entry.record.original.bytes : entry.output.bytes;
  const expectedMime = reused ? entry.record.original.mime : entry.output.mime;
  if (!file || file.status !== "ready" || file.kind !== entry.expected.kind || file.size !== expectedSize || file.mimeType !== expectedMime) {
    throw new Error(`${entry.logicalKey} remote Media does not match its exact file evidence.`);
  }
  if (!file.url || !/^https?:\/\//u.test(file.url) || !file.filename?.trim()) throw new Error(`${entry.logicalKey} remote Media projection is incomplete.`);
}

function validateRetainedReuse(manifest, entries, state) {
  const mediaById = exactMap(state.media, "id", "Ready Media");
  const detailById = exactMap(state.retainedDetails, "id", "Retained product details");
  const coveredDirectIds = new Set();
  const coveredPosterIds = new Set();
  const reusedIds = new Set();
  for (const entry of entries.filter((item) => item.remoteReuse)) {
    const product = manifest.products.find((item) => item.logicalKey === entry.expected.owner);
    if (!product?.retainedProductId || product.retainedProductId !== entry.remoteReuse.productId) {
      throw new Error(`${entry.logicalKey} remote reuse does not name its retained product authority.`);
    }
    const detail = detailById.get(product.retainedProductId);
    const directIds = new Set((detail?.media ?? []).filter((item) => item.status === "ready").map((item) => item.mediaId));
    const posterIds = new Set((detail?.media ?? []).map((item) => item.posterMediaId).filter(Boolean));
    const isPoster = entry.expected.role.startsWith("poster");
    if (isPoster ? !posterIds.has(entry.remoteReuse.mediaId) : !directIds.has(entry.remoteReuse.mediaId)) {
      throw new Error(`${entry.logicalKey} remote reuse is not attached to the retained product in the expected role.`);
    }
    if (reusedIds.has(entry.remoteReuse.mediaId)) throw new Error(`${entry.logicalKey} duplicates a retained Media reuse identity.`);
    reusedIds.add(entry.remoteReuse.mediaId);
    if (isPoster) coveredPosterIds.add(entry.remoteReuse.mediaId);
    else coveredDirectIds.add(entry.remoteReuse.mediaId);
    const remote = mediaById.get(entry.remoteReuse.mediaId);
    if (!remote) throw new Error(`${entry.logicalKey} retained Media ID is not ready.`);
    assertRemoteShape(remote, entry, { reused: true });
  }
  for (const product of manifest.products.filter((item) => item.retainedProductId)) {
    const detail = detailById.get(product.retainedProductId);
    for (const association of detail?.media ?? []) {
      if (association.status === "ready" && !coveredDirectIds.has(association.mediaId)) {
        throw new Error(`Retained product ${product.slug} has an existing ready Media ID without an explicit logical-key reuse mapping.`);
      }
    }
    for (const posterMediaId of new Set((detail?.media ?? []).map((item) => item.posterMediaId).filter(Boolean))) {
      if (!coveredPosterIds.has(posterMediaId)) throw new Error(`Retained product ${product.slug} has an existing poster Media ID without an explicit logical-key reuse mapping.`);
    }
  }
}

async function writeAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, filePath);
}

async function uploadFile(entry, session, mediaClient, journal, now) {
  if (!Number.isSafeInteger(session.expectedParts) || session.expectedParts < 1 || session.expectedParts > MAX_PARTS || !Number.isSafeInteger(session.partSize) || session.partSize < 1 || session.partSize > MAX_PART_BYTES) {
    throw new Error(`${entry.logicalKey} upload session exceeds the bounded multipart policy.`);
  }
  if (session.filename !== entry.output.filename || session.mimeType !== entry.output.mime || session.size !== entry.output.bytes) {
    throw new Error(`${entry.logicalKey} upload session does not match the staged file.`);
  }
  const expectedParts = Math.ceil(entry.output.bytes / session.partSize);
  if (session.expectedParts !== expectedParts) throw new Error(`${entry.logicalKey} upload session part count is inconsistent.`);
  const uploaded = new Set((session.uploadedParts ?? []).map((part) => part.partNumber));
  const handle = await open(entry.filePath, "r");
  try {
    for (let partNumber = 1; partNumber <= session.expectedParts; partNumber += 1) {
      if (uploaded.has(partNumber)) continue;
      const position = (partNumber - 1) * session.partSize;
      const length = Math.min(session.partSize, entry.output.bytes - position);
      const bytes = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(bytes, 0, length, position);
      if (bytesRead !== length) throw new Error(`${entry.logicalKey} staged file changed during upload.`);
      await mediaClient.uploadPart(session.id, partNumber, bytes);
      await journal({ logicalKey: entry.logicalKey, action: "upload", status: "part", sessionId: session.id, mediaId: session.mediaId, partNumber, timestamp: now().toISOString() });
    }
  } finally {
    await handle.close();
  }
  return mediaClient.complete(session.id);
}

function metadataUpdate(file, entry) {
  const desired = {
    altText: entry.expected.kind === "image" ? entry.expected.altText : undefined,
    caption: entry.expected.kind === "video" ? entry.expected.caption : undefined,
    width: entry.output.width,
    height: entry.output.height,
  };
  const changed = Object.entries(desired).some(([key, value]) => value !== undefined && (file[key] ?? null) !== (value ?? null));
  return changed ? { expectedVersion: file.version, ...desired } : null;
}

function posterPairs(entries) {
  const byOwner = new Map();
  for (const entry of entries) {
    const ownerEntries = byOwner.get(entry.expected.owner) ?? [];
    ownerEntries.push(entry);
    byOwner.set(entry.expected.owner, ownerEntries);
  }
  const pairs = [];
  for (const ownerEntries of byOwner.values()) {
    const videos = ownerEntries.filter((entry) => entry.expected.kind === "video").sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
    const posters = ownerEntries.filter((entry) => entry.expected.role.startsWith("poster")).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
    if (videos.length !== posters.length) {
      if (videos.length || posters.length) throw new Error(`${ownerEntries[0].expected.owner} must have one explicit poster per video.`);
      continue;
    }
    videos.forEach((video, index) => pairs.push({ video, poster: posters[index] }));
  }
  return pairs;
}

export async function runMediaUploadBridge({
  manifest,
  sourceManifest,
  stagedReport,
  stagedDir,
  journalPath,
  outputPath,
  readClient,
  mediaClient,
  readState = readFreshMediaState,
  hashRemote = hashRemoteMedia,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  now = () => new Date(),
  validatedLocal,
  requiredAssetCount = 237,
}) {
  const local = validatedLocal ?? await validateCompleteStagedInputs({ manifest, sourceManifest, stagedReport, stagedDir, requiredAssetCount });
  if (local.entries.length !== requiredAssetCount) {
    throw new Error(`Media upload is pinned to exactly ${requiredAssetCount} approved assets; validated input contains ${local.entries.length}.`);
  }
  const resume = await readUploadJournal(journalPath, local.fingerprint);
  const journal = (record) => appendUploadJournal(journalPath, record, local.fingerprint);
  let remote = await readState(readClient, manifest);
  validateRetainedReuse(manifest, local.entries, remote);
  let mediaById = exactMap(remote.media, "id", "Ready Media");
  let mediaByFilename = new Map();
  for (const file of remote.media) {
    const matches = mediaByFilename.get(file.filename) ?? [];
    matches.push(file);
    mediaByFilename.set(file.filename, matches);
  }
  const results = new Map();

  for (const entry of local.entries) {
    if (entry.remoteReuse) {
      const file = mediaById.get(entry.remoteReuse.mediaId);
      const digest = await hashRemote(file, entry.record.original.bytes, { fetchImpl, timeoutMs });
      if (digest !== entry.record.sha256) throw new Error(`${entry.logicalKey} retained Media hash does not match provenance.`);
      results.set(entry.logicalKey, { file, action: "retained-reuse", sha256: digest, width: entry.record.original.width, height: entry.record.original.height });
      await journal({ logicalKey: entry.logicalKey, action: "reuse", status: "retained-reuse", mediaId: file.id, timestamp: now().toISOString() });
      continue;
    }

    const saved = resume.get(entry.logicalKey);
    let candidate = saved?.mediaId ? mediaById.get(saved.mediaId) : null;
    const filenameMatches = mediaByFilename.get(entry.output.filename) ?? [];
    if (!candidate && filenameMatches.length > 1) throw new Error(`${entry.logicalKey} has ambiguous ready Media filename matches.`);
    candidate ??= filenameMatches[0] ?? null;
    let action = "uploaded";
    if (candidate) {
      assertRemoteShape(candidate, entry);
      const digest = await hashRemote(candidate, entry.output.bytes, { fetchImpl, timeoutMs });
      if (digest !== entry.output.sha256) throw new Error(`${entry.logicalKey} existing Media hash does not match the staged output.`);
      action = saved?.mediaId === candidate.id ? "resumed" : "adopted";
      await journal({ logicalKey: entry.logicalKey, action, status: "adopted", mediaId: candidate.id, timestamp: now().toISOString() });
    } else {
      let session = null;
      if (saved?.sessionId) {
        try {
          const resumed = await mediaClient.getSession(saved.sessionId);
          if (["initiated", "uploading", "completing", "committed"].includes(resumed.state)) session = resumed;
        } catch {
          session = null;
        }
      }
      if (!session) {
        session = await mediaClient.initiate({ filename: entry.output.filename, mimeType: entry.output.mime, size: entry.output.bytes });
        await journal({ logicalKey: entry.logicalKey, action: "upload", status: "session", sessionId: session.id, mediaId: session.mediaId, timestamp: now().toISOString() });
      }
      if (session.state === "committed") {
        remote = await readState(readClient, manifest);
        mediaById = exactMap(remote.media, "id", "Ready Media");
        candidate = mediaById.get(session.mediaId);
        if (!candidate) throw new Error(`${entry.logicalKey} committed upload is missing from fresh Media reads.`);
      } else {
        candidate = await uploadFile(entry, session, mediaClient, journal, now);
      }
      assertRemoteShape(candidate, entry);
      const update = metadataUpdate(candidate, entry);
      if (update) candidate = await mediaClient.update(candidate.id, update);
      results.set(entry.logicalKey, { file: candidate, action, sha256: entry.output.sha256, width: entry.output.width, height: entry.output.height });
      mediaById.set(candidate.id, candidate);
      mediaByFilename.set(candidate.filename, [candidate]);
      await journal({ logicalKey: entry.logicalKey, action, status: "ready", sessionId: session.id, mediaId: candidate.id, timestamp: now().toISOString() });
      continue;
    }
    const update = metadataUpdate(candidate, entry);
    if (update) candidate = await mediaClient.update(candidate.id, update);
    results.set(entry.logicalKey, { file: candidate, action, sha256: entry.output.sha256, width: entry.output.width, height: entry.output.height });
    mediaById.set(candidate.id, candidate);
  }

  remote = await readState(readClient, manifest);
  mediaById = exactMap(remote.media, "id", "Fresh ready Media");
  const pairs = posterPairs(local.entries);
  for (const pair of pairs) {
    const videoResult = results.get(pair.video.logicalKey);
    const posterResult = results.get(pair.poster.logicalKey);
    let video = mediaById.get(videoResult.file.id);
    const poster = mediaById.get(posterResult.file.id);
    if (!video || !poster || video.kind !== "video" || poster.kind !== "image") throw new Error(`Poster relationship is unresolved for ${pair.video.logicalKey}.`);
    if (video.posterMediaId !== poster.id) {
      video = await mediaClient.update(video.id, { expectedVersion: video.version, posterMediaId: poster.id });
      mediaById.set(video.id, video);
    }
    await journal({ logicalKey: pair.video.logicalKey, action: "poster", status: "poster-linked", mediaId: video.id, posterMediaId: poster.id, timestamp: now().toISOString() });
  }

  remote = await readState(readClient, manifest);
  mediaById = exactMap(remote.media, "id", "Verified ready Media");
  const pairByVideo = new Map(pairs.map((pair) => [pair.video.logicalKey, pair.poster.logicalKey]));
  const pairByPoster = new Map(pairs.map((pair) => [pair.poster.logicalKey, pair.video.logicalKey]));
  const assets = local.entries.map((entry) => {
    const result = results.get(entry.logicalKey);
    const file = mediaById.get(result.file.id);
    if (!file) throw new Error(`${entry.logicalKey} is missing from final fresh Media reads.`);
    assertRemoteShape(file, entry, { reused: result.action === "retained-reuse" });
    const posterLogicalKey = pairByVideo.get(entry.logicalKey) ?? null;
    const posterMediaId = posterLogicalKey ? results.get(posterLogicalKey).file.id : null;
    if (posterMediaId && file.posterMediaId !== posterMediaId) throw new Error(`${entry.logicalKey} poster relationship did not persist.`);
    return {
      logicalKey: entry.logicalKey,
      mediaId: file.id,
      status: "ready",
      kind: entry.expected.kind,
      sha256: result.sha256,
      url: file.url,
      filename: file.filename,
      size: file.size,
      createdAt: isoTimestamp(file.createdAt),
      width: result.width,
      height: result.height,
      importAction: result.action,
      ...(posterLogicalKey ? { posterLogicalKey, posterMediaId } : {}),
      ...(pairByPoster.has(entry.logicalKey) ? { posterForLogicalKey: pairByPoster.get(entry.logicalKey) } : {}),
    };
  });
  const report = {
    schemaVersion: 1,
    status: "complete",
    verifiedAt: now().toISOString(),
    manifestFingerprint: manifestReadinessFingerprint(manifest),
    assets,
    unversionedSettings: [],
    presentation: {},
    evidence: { productsMutated: false, publicationMutated: false, uploadOrder: "sequential", posterLinksVerified: pairs.length },
  };
  const readiness = validateStagedAssetReadiness(manifest, report);
  if (!readiness.ok) throw new Error(`Generated apply readiness failed:\n- ${readiness.errors.join("\n- ")}`);
  await writeAtomic(outputPath, report);
  return { report, summary: { total: assets.length, uploaded: assets.filter((item) => item.importAction === "uploaded").length, reused: assets.filter((item) => item.importAction === "retained-reuse").length, adopted: assets.filter((item) => ["adopted", "resumed"].includes(item.importAction)).length, posterLinks: pairs.length } };
}
