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
const SOURCE_KIND_LICENSES = Object.freeze({
  "merchant-owned": new Set(["Proprietary-Merchant-Owned"]),
  pexels: new Set(["Pexels"]),
  "wikimedia-commons": new Set(["CC0-1.0", "PDM-1.0", "CC-BY-4.0"]),
  "openverse-verified": new Set(["CC0-1.0", "PDM-1.0", "CC-BY-4.0"]),
  "generated-original": new Set(["Generated-Original"]),
});
const SHA256 = /^[a-f0-9]{64}$/;
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

export function parseIsoCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]) return null;
  return year * 10_000 + month * 100 + day;
}

function currentIsoCalendarDate(now) {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function validateSourceManifest(
  manifest,
  expectedAssets,
  { today = currentIsoCalendarDate(new Date()) } = {},
) {
  const errors = [];
  const todayValue = parseIsoCalendarDate(today);
  if (todayValue === null) throw new Error("today must be a real ISO calendar date");
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
    const acquiredAt = parseIsoCalendarDate(record.acquiredAt);
    const verifiedAt = parseIsoCalendarDate(record.verifiedAt);
    if (acquiredAt === null) errors.push(`${prefix}.acquiredAt must be a real ISO calendar date`);
    if (verifiedAt === null) errors.push(`${prefix}.verifiedAt must be a real ISO calendar date`);
    if (acquiredAt !== null && verifiedAt !== null && acquiredAt > verifiedAt) {
      errors.push(`${prefix}.acquiredAt must be on or before verifiedAt`);
    }
    if (verifiedAt !== null && verifiedAt > todayValue) errors.push(`${prefix}.verifiedAt cannot be in the future`);
    if (!record.creator?.trim()) errors.push(`${prefix}.creator is required`);
    if (!ALLOWED_LICENSES.has(record.license?.code)) errors.push(`${prefix}.license.code is not approved`);
    const pairedLicenses = SOURCE_KIND_LICENSES[record.sourceKind];
    if (pairedLicenses && !pairedLicenses.has(record.license?.code)) {
      errors.push(`${prefix}.license.code does not match sourceKind ${record.sourceKind}`);
    }
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
