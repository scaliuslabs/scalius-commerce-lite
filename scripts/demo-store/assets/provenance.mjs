import path from "node:path";

const SOURCE_KINDS = new Set([
  "merchant-owned",
  "pexels",
  "wikimedia-commons",
  "openverse-verified",
  "generated-original",
]);
const ALLOWED_LICENSES = new Set([
  "CC0-1.0",
  "PDM-1.0",
  "CC-BY-4.0",
  "Pexels",
  "Proprietary-Merchant-Owned",
  "Generated-Original",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MIME = /^(?:image\/(?:jpeg|png|gif|webp|avif)|video\/(?:mp4|webm))$/;
const POSITIONS = new Set([
  "centre", "north", "northeast", "east", "southeast",
  "south", "southwest", "west", "northwest", "entropy", "attention",
]);

function isHttps(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function validateSourceManifest(manifest, expectedAssets) {
  const errors = [];
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest?.assets)) {
    return { errors: ["Source manifest must use schemaVersion 1 and an assets array"], records: new Map() };
  }
  const expected = new Map(expectedAssets.map((asset) => [asset.logicalKey, asset]));
  const records = new Map();

  for (const [index, record] of manifest.assets.entries()) {
    const prefix = `assets[${index}]`;
    if (!record || typeof record !== "object") {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const key = record.logicalKey;
    if (!expected.has(key)) errors.push(`${prefix}.logicalKey is not in the demo manifest: ${key ?? "missing"}`);
    if (records.has(key)) errors.push(`${prefix}.logicalKey is duplicated: ${key}`);
    if (typeof key === "string") records.set(key, record);
    if (record.status !== "approved") errors.push(`${prefix}.status must be approved before staging`);
    if (!SOURCE_KINDS.has(record.sourceKind)) errors.push(`${prefix}.sourceKind is unsupported`);
    if (!record.sourceFile || path.isAbsolute(record.sourceFile) || record.sourceFile.split(/[\\/]/).includes("..")) {
      errors.push(`${prefix}.sourceFile must be a relative path without traversal`);
    }
    if (!SHA256.test(record.sha256 ?? "")) errors.push(`${prefix}.sha256 must be a lowercase SHA-256 digest`);
    if (!DATE.test(record.acquiredAt ?? "") || !DATE.test(record.verifiedAt ?? "")) errors.push(`${prefix} needs acquiredAt and verifiedAt ISO dates`);
    if (!record.creator?.trim()) errors.push(`${prefix}.creator is required`);
    if (!ALLOWED_LICENSES.has(record.license?.code)) errors.push(`${prefix}.license.code is not approved`);
    if (!isHttps(record.license?.url)) errors.push(`${prefix}.license.url must be HTTPS`);
    if (record.license?.code === "CC-BY-4.0" && !record.license?.attribution?.trim()) errors.push(`${prefix}.license.attribution is required for CC BY`);
    if (["pexels", "wikimedia-commons", "openverse-verified"].includes(record.sourceKind)) {
      if (!isHttps(record.sourcePageUrl) || !isHttps(record.originalFileUrl)) errors.push(`${prefix} needs verified HTTPS source-page and original-file URLs`);
    }
    if (record.sourceKind === "merchant-owned" && !record.merchantOwnershipReference?.trim()) errors.push(`${prefix}.merchantOwnershipReference is required`);
    if (record.sourceKind === "generated-original" && (!record.generation?.prompt?.trim() || !record.generation?.model?.trim())) errors.push(`${prefix}.generation prompt and model are required`);
    if (!MIME.test(record.original?.mime ?? "") || !Number.isInteger(record.original?.bytes) || record.original.bytes <= 0) errors.push(`${prefix}.original MIME and byte size are required`);
    if (!Number.isInteger(record.original?.width) || record.original.width <= 0 || !Number.isInteger(record.original?.height) || record.original.height <= 0) errors.push(`${prefix}.original dimensions are required`);
    if (!POSITIONS.has(record.cropPosition ?? "centre")) errors.push(`${prefix}.cropPosition is unsupported`);
    const review = record.rightsReview;
    if (!review?.reviewedBy?.trim() || !review?.noWatermark || !review?.noVisibleBranding || !review?.noTrademarkedCharacter || !review?.noIdentifiableEndorser || !review?.optionAppearanceVerified) {
      errors.push(`${prefix}.rightsReview must explicitly pass every visual-rights check`);
    }
  }

  return { errors, records };
}
