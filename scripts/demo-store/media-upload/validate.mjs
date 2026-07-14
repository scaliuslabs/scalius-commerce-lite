import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { buildExpectedAssets } from "../assets/expected-assets.mjs";
import { deterministicAssetFilename } from "../assets/profiles.mjs";
import { validateSourceManifest } from "../assets/provenance.mjs";

async function fileSha256(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

function exactMap(rows, key, label) {
  const result = new Map();
  for (const row of rows ?? []) {
    const value = row?.[key];
    if (!value || result.has(value)) throw new Error(`${label} has a missing or duplicate ${key}: ${value ?? "<missing>"}.`);
    result.set(value, row);
  }
  return result;
}

function assertGeneratedLicense(record) {
  if (record.sourceKind === "generated-original" && record.license?.code !== "Generated-Original") {
    throw new Error(`${record.logicalKey} generated-original provenance requires the Generated-Original license.`);
  }
}

function retainedMediaAuthority(record, expected) {
  const fields = ["remoteReuse", "retainedReplacement"].filter((field) => record[field] !== undefined);
  if (fields.length > 1) throw new Error(`${record.logicalKey} cannot both reuse and replace retained Media.`);
  if (fields.length === 0) return { remoteReuse: null, retainedReplacement: null };
  const field = fields[0];
  const authority = record[field];
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    throw new Error(`${record.logicalKey}.${field} must be an object.`);
  }
  if (!/^[A-Za-z0-9_-]{8,160}$/u.test(authority.productId ?? "") || !/^[A-Za-z0-9_-]{8,160}$/u.test(authority.mediaId ?? "")) {
    throw new Error(`${record.logicalKey}.${field} requires exact productId and mediaId values.`);
  }
  if (!expected.owner.startsWith("product:")) throw new Error(`${record.logicalKey}.${field} is allowed only for retained product media.`);
  return {
    remoteReuse: field === "remoteReuse" ? { productId: authority.productId, mediaId: authority.mediaId } : null,
    retainedReplacement: field === "retainedReplacement" ? { productId: authority.productId, mediaId: authority.mediaId } : null,
  };
}

export async function validateCompleteStagedInputs({ manifest, sourceManifest, stagedReport, stagedDir, requiredAssetCount = 237 }) {
  const expectedAssets = buildExpectedAssets(manifest);
  if (expectedAssets.length !== requiredAssetCount) {
    throw new Error(`Media upload is pinned to exactly ${requiredAssetCount} approved assets; the manifest currently requires ${expectedAssets.length}.`);
  }
  const sourceCheck = validateSourceManifest(sourceManifest, expectedAssets);
  if (sourceCheck.errors.length) throw new Error(`Source manifest is invalid:\n- ${sourceCheck.errors.join("\n- ")}`);
  if (sourceCheck.records.size !== expectedAssets.length) throw new Error(`Source manifest must contain exactly ${expectedAssets.length} approved records.`);
  if (stagedReport?.schemaVersion !== 1 || stagedReport?.mode !== "stage" || stagedReport?.ready !== true) {
    throw new Error("Media upload requires a complete stage-mode readiness report.");
  }
  if ((stagedReport.manifestErrors ?? []).length) throw new Error("Staged readiness contains manifest errors.");
  const stagedByKey = exactMap(stagedReport.assets, "logicalKey", "Staged readiness");
  if (stagedByKey.size !== expectedAssets.length) throw new Error(`Staged readiness must contain exactly ${expectedAssets.length} assets.`);

  const entries = [];
  for (const expected of expectedAssets) {
    const record = sourceCheck.records.get(expected.logicalKey);
    const staged = stagedByKey.get(expected.logicalKey);
    if (!record || !staged || staged.status !== "staged") throw new Error(`${expected.logicalKey} is not completely staged.`);
    assertGeneratedLicense(record);
    if (staged.kind !== expected.kind || staged.profile !== expected.profile) throw new Error(`${expected.logicalKey} staged kind/profile does not match the catalog intent.`);
    if (staged.source?.sha256 !== record.sha256) throw new Error(`${expected.logicalKey} staged source hash does not match provenance.`);
    const output = staged.output;
    const expectedFilename = deterministicAssetFilename({ ...expected, mime: record.original.mime }, record.sha256);
    if (output?.filename !== expectedFilename || !/^[a-f0-9]{64}$/u.test(output?.sha256 ?? "")) {
      throw new Error(`${expected.logicalKey} has invalid deterministic output evidence.`);
    }
    if (!Number.isSafeInteger(output.bytes) || output.bytes <= 0 || !Number.isSafeInteger(output.width) || output.width <= 0 || !Number.isSafeInteger(output.height) || output.height <= 0) {
      throw new Error(`${expected.logicalKey} has incomplete output dimensions or size.`);
    }
    if (expected.kind === "image" && output.mime !== "image/webp") throw new Error(`${expected.logicalKey} must stage as WebP.`);
    if (expected.kind === "video" && output.mime !== record.original.mime) throw new Error(`${expected.logicalKey} staged video MIME changed.`);
    const filePath = path.resolve(stagedDir, output.filename);
    const relative = path.relative(path.resolve(stagedDir), filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${expected.logicalKey} output path escapes the staged directory.`);
    const info = await stat(filePath);
    if (info.size !== output.bytes) throw new Error(`${expected.logicalKey} staged byte size changed.`);
    if (await fileSha256(filePath) !== output.sha256) throw new Error(`${expected.logicalKey} staged SHA-256 changed.`);
    const retainedAuthority = retainedMediaAuthority(record, expected);
    entries.push({
      logicalKey: expected.logicalKey,
      expected,
      record,
      staged,
      output,
      filePath,
      ...retainedAuthority,
    });
  }

  const fingerprint = createHash("sha256").update(JSON.stringify(entries.map((entry) => ({
    logicalKey: entry.logicalKey,
    sourceSha256: entry.record.sha256,
    outputSha256: entry.output.sha256,
    remoteReuse: entry.remoteReuse,
    retainedReplacement: entry.retainedReplacement,
  })))).digest("hex");
  return { entries, fingerprint };
}
