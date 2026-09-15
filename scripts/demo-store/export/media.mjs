/**
 * The media side of a portable seed bundle.
 *
 * `seed.sql` restores the `media` rows, but a row is only half of an asset: the
 * receiving deployment still has to put the bytes behind each object key into
 * its own object store. `media-manifest.json` is the machine-readable half of
 * that handover. It lists one entry per exported asset, keyed by object key,
 * with the identity a loader needs (filename, kind, mime type, byte size,
 * dimensions, duration) and every logical reference inside the bundle that
 * points at the asset, so an operator can see what breaks if an object is
 * missing.
 *
 * References are derived from the foreign-key edges the bundle actually
 * carries: the folder the asset sits in, the poster relationships between media
 * rows, the `product_media` attachments, and the variants whose image points at
 * one of those attachments. Assets referenced only from free-form presentation
 * JSON (hero configs, rich content HTML) are not inferred here, because
 * guessing at a reference is worse than not claiming one.
 *
 * When `--media-source-dir` is supplied the exporter also copies the bytes.
 * Every object is checked for presence and size, and hashed, before a single
 * byte is written to the bundle, so a missing object fails the whole export
 * rather than producing a bundle that claims a media directory it only half
 * filled.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { DEMO_STORE_SEED_CONTRACT, MEDIA_DIRECTORY_NAME } from "./tables.mjs";

const SAMPLE_LIMIT = 10;

function formatList(entries) {
  const unique = [...new Set(entries)].sort();
  if (unique.length <= SAMPLE_LIMIT) return unique.join(", ");
  return `${unique.slice(0, SAMPLE_LIMIT).join(", ")} and ${unique.length - SAMPLE_LIMIT} more`;
}

/**
 * Object keys become path segments under `<bundle>/media/`, so a key that
 * escapes its directory is refused rather than followed.
 */
export function resolveObjectPath(baseDirectory, objectKey) {
  const base = path.resolve(baseDirectory);
  const resolved = path.resolve(base, objectKey);
  if (path.isAbsolute(objectKey) || !resolved.startsWith(base + path.sep)) {
    throw new Error(
      `Media object key ${JSON.stringify(objectKey)} resolves outside the media directory. `
      + "A portable demo-store seed only carries object keys that are relative paths inside the store.",
    );
  }
  return resolved;
}

export function buildMediaReferenceIndex(tables) {
  const productMediaByMedia = new Map();
  const variantsByProductMedia = new Map();
  const postersByMedia = new Map();

  for (const row of tables.get("product_media").rows) {
    const entries = productMediaByMedia.get(row.media_id) ?? [];
    entries.push({
      productMediaId: row.id,
      productId: row.product_id,
      isPrimary: Number(row.is_primary) === 1,
      sortOrder: Number(row.sort_order),
    });
    productMediaByMedia.set(row.media_id, entries);
  }
  const mediaIdByProductMediaId = new Map(
    tables.get("product_media").rows.map((row) => [row.id, row.media_id]),
  );
  for (const row of tables.get("product_variants").rows) {
    if (row.image_id === null) continue;
    const mediaId = mediaIdByProductMediaId.get(row.image_id);
    if (mediaId === undefined) continue;
    const entries = variantsByProductMedia.get(mediaId) ?? [];
    entries.push({ variantId: row.id, productId: row.product_id, productMediaId: row.image_id });
    variantsByProductMedia.set(mediaId, entries);
  }
  for (const row of tables.get("media").rows) {
    if (row.poster_media_id === null) continue;
    const entries = postersByMedia.get(row.poster_media_id) ?? [];
    entries.push(row.id);
    postersByMedia.set(row.poster_media_id, entries);
  }

  return { productMediaByMedia, variantsByProductMedia, postersByMedia };
}

function referencesFor(row, index) {
  const attachments = (index.productMediaByMedia.get(row.id) ?? [])
    .slice()
    .sort((left, right) => left.productMediaId.localeCompare(right.productMediaId));
  const variantImages = (index.variantsByProductMedia.get(row.id) ?? [])
    .slice()
    .sort((left, right) => left.variantId.localeCompare(right.variantId));
  const posterFor = (index.postersByMedia.get(row.id) ?? []).slice().sort();
  return {
    folderId: row.folder_id,
    posterMediaId: row.poster_media_id,
    posterFor,
    productMedia: attachments,
    variantImages,
  };
}

/**
 * Builds the manifest entries, sorted by object key so two exports of the same
 * database produce the same bytes. `sha256` and `bytesVerified` are only
 * populated when the bytes were actually read, never inferred.
 */
export function buildMediaManifest({ revision, tables, digestsByObjectKey = null }) {
  const index = buildMediaReferenceIndex(tables);
  const objects = tables.get("media").rows
    .map((row) => ({
      id: row.id,
      objectKey: row.object_key,
      filename: row.filename,
      kind: row.kind,
      mimeType: row.mime_type,
      byteSize: Number(row.size),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      sha256: digestsByObjectKey?.get(row.object_key) ?? null,
      bytesIncluded: digestsByObjectKey !== null,
      references: referencesFor(row, index),
    }))
    .sort((left, right) => left.objectKey.localeCompare(right.objectKey));
  return {
    contract: DEMO_STORE_SEED_CONTRACT,
    schema: { version: revision.version, name: revision.name, sourceSha256: revision.sourceSha256 },
    mediaDirectory: digestsByObjectKey === null ? null : MEDIA_DIRECTORY_NAME,
    count: objects.length,
    objects,
  };
}

/**
 * Verifies and hashes every exported object against `--media-source-dir`.
 * Presence and size are checked for all objects first, so the operator sees the
 * complete list of what is wrong instead of one failure at a time, and nothing
 * has been written to the bundle by the time the error is raised.
 */
export async function resolveMediaObjects({ mediaSourceDirectory, mediaRows }) {
  const planned = mediaRows.map((row) => ({
    objectKey: row.object_key,
    mediaId: row.id,
    expectedBytes: Number(row.size),
    sourcePath: resolveObjectPath(mediaSourceDirectory, row.object_key),
  }));

  const missing = [];
  const mismatched = [];
  for (const object of planned) {
    let stats;
    try {
      stats = await stat(object.sourcePath);
    } catch {
      missing.push(object.objectKey);
      continue;
    }
    if (!stats.isFile()) {
      missing.push(object.objectKey);
      continue;
    }
    if (stats.size !== object.expectedBytes) {
      mismatched.push(`${object.objectKey} (media row ${object.mediaId} records ${object.expectedBytes} bytes, file is ${stats.size})`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} exported media object(s) are missing from ${mediaSourceDirectory}: ${formatList(missing)}. `
      + "A portable demo-store seed is only written when every object it names is present, so no partial media copy is produced.",
    );
  }
  if (mismatched.length > 0) {
    throw new Error(
      `${mismatched.length} exported media object(s) do not match the byte size recorded on their media row: ${formatList(mismatched)}. `
      + "Reconcile the object store with the catalog before exporting a portable seed.",
    );
  }

  const digestsByObjectKey = new Map();
  for (const object of planned) {
    const hash = createHash("sha256");
    await pipeline(createReadStream(object.sourcePath), hash);
    digestsByObjectKey.set(object.objectKey, hash.digest("hex"));
  }
  return { planned, digestsByObjectKey };
}
