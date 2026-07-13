import { createHash } from "node:crypto";

import { buildExpectedAssets } from "./assets/expected-assets.mjs";
import { ASSET_PROFILES } from "./assets/profiles.mjs";

function requiredMedia(manifest) {
  return [
    ...manifest.categories.flatMap((category) => category.media),
    ...manifest.products.flatMap((product) => product.media),
    ...manifest.heroes.flatMap((hero) => hero.media),
  ];
}

export function manifestReadinessFingerprint(manifest) {
  const expectedAssets = buildExpectedAssets(manifest);
  const intent = {
    schemaVersion: manifest.schemaVersion,
    categories: manifest.categories.map((item) => item.slug),
    products: manifest.products.map((item) => ({ slug: item.slug, variants: item.variants.map((variant) => variant.optionValues) })),
    media: expectedAssets.map((item) => ({
      logicalKey: item.logicalKey,
      owner: item.owner,
      kind: item.kind,
      role: item.role,
      profile: item.profile,
      intendedCrop: item.intendedCrop,
      altText: item.altText,
      caption: item.caption,
    })),
    collections: manifest.collections.map((item) => item.logicalKey),
    heroes: manifest.heroes.map((item) => item.logicalKey),
  };
  return createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}

export function validateStagedAssetReadiness(manifest, report) {
  const errors = [];
  const expectedAssets = buildExpectedAssets(manifest);
  const expectedByKey = new Map(expectedAssets.map((asset) => [asset.logicalKey, asset]));
  const retainedOwners = new Set(manifest.products
    .filter((product) => product.retainedProductId)
    .map((product) => product.logicalKey));
  if (report?.schemaVersion !== 1) errors.push("readiness schemaVersion must be 1");
  if (report?.status !== "complete") errors.push("readiness status must be complete");
  if (!report?.verifiedAt || !Number.isFinite(Date.parse(report.verifiedAt))) errors.push("readiness verifiedAt must be an ISO timestamp");
  const fingerprint = manifestReadinessFingerprint(manifest);
  if (report?.manifestFingerprint !== fingerprint) errors.push("readiness manifest fingerprint does not match");
  if (!Array.isArray(report?.assets)) errors.push("readiness assets must be an array");
  if (report?.unversionedSettings?.length) errors.push("unversioned header/footer settings cannot be applied safely");

  const assets = new Map();
  const mediaIds = new Set();
  for (const asset of report?.assets ?? []) {
    if (!asset?.logicalKey || assets.has(asset.logicalKey)) {
      errors.push(`duplicate or missing staged logical key: ${asset?.logicalKey ?? "<missing>"}`);
      continue;
    }
    assets.set(asset.logicalKey, asset);
    if (asset.status !== "ready") errors.push(`${asset.logicalKey} is not ready`);
    if (!/^[A-Za-z0-9_-]{8,160}$/u.test(asset.mediaId ?? "")) errors.push(`${asset.logicalKey} has an invalid media ID`);
    if (mediaIds.has(asset.mediaId)) errors.push(`${asset.logicalKey} reuses media ID ${asset.mediaId}`);
    mediaIds.add(asset.mediaId);
    if (!/^[a-f0-9]{64}$/u.test(asset.sha256 ?? "")) errors.push(`${asset.logicalKey} needs a SHA-256 digest`);
    if (!asset.url || !/^https?:\/\//u.test(asset.url)) errors.push(`${asset.logicalKey} needs an absolute media URL`);
    if (!asset.filename?.trim() || !Number.isSafeInteger(asset.size) || asset.size <= 0) errors.push(`${asset.logicalKey} has incomplete file metadata`);
    if (!Number.isFinite(Date.parse(asset.createdAt ?? ""))) errors.push(`${asset.logicalKey} needs a creation timestamp`);
    if (!Number.isSafeInteger(asset.width) || asset.width <= 0 || !Number.isSafeInteger(asset.height) || asset.height <= 0) errors.push(`${asset.logicalKey} needs positive dimensions`);
    const expected = expectedByKey.get(asset.logicalKey);
    const profile = expected ? ASSET_PROFILES[expected.profile] : null;
    const retainedReuse = asset.importAction === "retained-reuse"
      && expected?.owner
      && retainedOwners.has(expected.owner);
    if (profile?.kind === "image" && !retainedReuse
      && (asset.width !== profile.width || asset.height !== profile.height)) {
      errors.push(`${asset.logicalKey} dimensions do not match ${expected.profile}`);
    }
  }
  for (const intent of requiredMedia(manifest)) {
    const asset = assets.get(intent.logicalKey);
    if (!asset) errors.push(`missing staged asset ${intent.logicalKey}`);
    else if ((intent.kind ?? "image") !== asset.kind) errors.push(`${intent.logicalKey} kind does not match staged media`);
  }
  if (assets.size !== requiredMedia(manifest).length) errors.push("staged asset count does not exactly match the manifest");
  return { ok: errors.length === 0, errors, fingerprint, assets };
}

export function assertStagedAssetReadiness(manifest, report) {
  const result = validateStagedAssetReadiness(manifest, report);
  if (!result.ok) {
    const error = new Error(`Staged asset readiness is incomplete:\n- ${result.errors.join("\n- ")}`);
    error.name = "StagedAssetReadinessError";
    throw error;
  }
  return result;
}
