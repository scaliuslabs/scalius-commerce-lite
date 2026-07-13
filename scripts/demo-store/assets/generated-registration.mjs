import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildExpectedAssets } from "./expected-assets.mjs";
import { inspectLocalAsset } from "./inspect-local-asset.mjs";
import { validateSourceManifest } from "./provenance.mjs";

export const DEFAULT_REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../../", import.meta.url)),
);

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertPrivateDataPath(candidate, label, repoRoot = DEFAULT_REPO_ROOT) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRepoRoot = path.resolve(repoRoot);
  if (!isPathInside(resolvedRepoRoot, resolvedCandidate)) return;
  const relative = path.relative(resolvedRepoRoot, resolvedCandidate);
  if (relative === ".wrangler" || relative.startsWith(`.wrangler${path.sep}`)) return;
  throw new Error(`${label} inside the repository must be under .wrangler; refusing ${resolvedCandidate}`);
}

async function resolveManifestTarget(manifestPath) {
  const parent = path.dirname(path.resolve(manifestPath));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return path.join(await realpath(parent), path.basename(manifestPath));
}

async function readPrivateManifest(manifestPath) {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed?.assets)) {
      throw new Error("Private generated-asset manifest must use schemaVersion 1 and an assets array");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 1, assets: [] };
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function exactLogicalKeys(logicalKeys, expectedByKey) {
  if (!Array.isArray(logicalKeys) || logicalKeys.length === 0) {
    throw new Error("At least one exact logical key is required");
  }
  const unique = new Set();
  for (const key of logicalKeys) {
    if (typeof key !== "string" || !key.trim() || key !== key.trim()) {
      throw new Error("Logical keys must be non-empty exact strings without surrounding whitespace");
    }
    if (unique.has(key)) throw new Error(`Logical key is duplicated: ${key}`);
    if (!expectedByKey.has(key)) throw new Error(`Logical key is not in the demo manifest: ${key}`);
    unique.add(key);
  }
  return [...unique];
}

function assertUnambiguousAssets(assets) {
  const keys = new Set();
  for (const record of assets) {
    if (keys.has(record?.logicalKey)) {
      throw new Error(`Private manifest contains duplicate logical key: ${record?.logicalKey}`);
    }
    keys.add(record?.logicalKey);
  }
}

export async function registerGeneratedAssets({
  manifestPath,
  sourceDir,
  sourceFile,
  logicalKeys,
  prompt,
  model,
  creator,
  rightsUrl,
  acquiredAt,
  verifiedAt,
  cropPosition = "centre",
  rightsReview,
  expectedAssets = buildExpectedAssets(),
  today,
  repoRoot = DEFAULT_REPO_ROOT,
}) {
  if (!manifestPath) throw new Error("An explicit private manifest path is required");
  if (!sourceDir || !sourceFile) throw new Error("An explicit private source directory and source file are required");

  assertPrivateDataPath(path.resolve(manifestPath), "Generated-asset manifest", repoRoot);
  const resolvedManifestPath = await resolveManifestTarget(manifestPath);
  assertPrivateDataPath(resolvedManifestPath, "Generated-asset manifest", repoRoot);
  assertPrivateDataPath(path.resolve(sourceDir), "Generated-asset source directory", repoRoot);
  assertPrivateDataPath(path.resolve(sourceFile), "Generated-asset source file", repoRoot);
  const resolvedSourceDir = await realpath(path.resolve(sourceDir));
  const resolvedSourceFile = await realpath(path.resolve(sourceFile));
  assertPrivateDataPath(resolvedSourceDir, "Generated-asset source directory", repoRoot);
  assertPrivateDataPath(resolvedSourceFile, "Generated-asset source file", repoRoot);
  if (!isPathInside(resolvedSourceDir, resolvedSourceFile) || resolvedSourceDir === resolvedSourceFile) {
    throw new Error("Generated-asset source file must be inside the source directory");
  }

  const expectedByKey = new Map(expectedAssets.map((asset) => [asset.logicalKey, asset]));
  const keys = exactLogicalKeys(logicalKeys, expectedByKey);
  const inspected = await inspectLocalAsset(resolvedSourceFile);
  for (const key of keys) {
    const expectedKind = expectedByKey.get(key).kind;
    if (expectedKind !== inspected.kind) {
      throw new Error(`${key} expects ${expectedKind}, but the local file is ${inspected.kind}`);
    }
  }

  const manifest = await readPrivateManifest(resolvedManifestPath);
  assertUnambiguousAssets(manifest.assets);
  const sourceRelative = path.relative(resolvedSourceDir, resolvedSourceFile).split(path.sep).join("/");
  const records = new Map(manifest.assets.map((record) => [record.logicalKey, record]));
  for (const logicalKey of keys) {
    records.set(logicalKey, {
      logicalKey,
      status: "approved",
      sourceKind: "generated-original",
      sourceFile: sourceRelative,
      creator,
      license: {
        code: "Generated-Original",
        url: rightsUrl,
        attribution: "",
      },
      acquiredAt,
      verifiedAt,
      sha256: inspected.sha256,
      original: {
        mime: inspected.mime,
        bytes: inspected.bytes.length,
        width: inspected.width,
        height: inspected.height,
      },
      cropPosition,
      generation: { prompt, model },
      rightsReview,
    });
  }

  const expectedOrder = new Map(expectedAssets.map((asset, index) => [asset.logicalKey, index]));
  const nextManifest = {
    schemaVersion: 1,
    assets: [...records.values()].sort((left, right) =>
      (expectedOrder.get(left.logicalKey) ?? Number.MAX_SAFE_INTEGER)
      - (expectedOrder.get(right.logicalKey) ?? Number.MAX_SAFE_INTEGER),
    ),
  };
  const validation = validateSourceManifest(nextManifest, expectedAssets, {
    ...(today ? { today } : {}),
  });
  if (validation.errors.length > 0) {
    throw new Error(`Generated-asset registration is invalid:\n- ${validation.errors.join("\n- ")}`);
  }

  await writeJsonAtomic(resolvedManifestPath, nextManifest);
  return {
    manifestPath: resolvedManifestPath,
    logicalKeys: keys,
    sourceFile: sourceRelative,
    source: {
      kind: inspected.kind,
      mime: inspected.mime,
      bytes: inspected.bytes.length,
      width: inspected.width,
      height: inspected.height,
      sha256: inspected.sha256,
    },
    assetCount: nextManifest.assets.length,
  };
}
