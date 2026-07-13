import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { buildExpectedAssets } from "./expected-assets.mjs";
import {
  ASSET_PROFILES,
  deterministicAssetFilename,
  IMAGE_MIMES,
  IMAGE_MIME_LIMIT_BYTES,
  VIDEO_MIMES,
  VIDEO_MIME_LIMIT_BYTES,
} from "./profiles.mjs";
import { validateSourceManifest } from "./provenance.mjs";

const requireFromStorefront = createRequire(
  new URL("../../../apps/storefront/package.json", import.meta.url),
);
const sharp = requireFromStorefront("sharp");
const execFileAsync = promisify(execFile);

const FORMAT_TO_MIME = Object.freeze({
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function inspectVideo(filePath, mime) {
  const prefix = await readFile(filePath).then((bytes) => bytes.subarray(0, 16));
  const detected = prefix.subarray(4, 8).toString("ascii") === "ftyp"
    ? "video/mp4"
    : prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      ? "video/webm"
      : null;
  if (detected !== mime) throw new Error(`Detected ${detected ?? "unknown video"}, declared ${mime}`);

  let stdout;
  try {
    ({ stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "json", filePath,
    ]));
  } catch {
    throw new Error("ffprobe is required to verify video dimensions");
  }
  const stream = JSON.parse(stdout).streams?.[0];
  if (!Number.isInteger(stream?.width) || !Number.isInteger(stream?.height)) {
    throw new Error("Video has no readable visual dimensions");
  }
  return { mime: detected, width: stream.width, height: stream.height };
}

async function validateSourceFile(filePath, record, expected) {
  const info = await stat(filePath);
  const limit = expected.kind === "video" ? VIDEO_MIME_LIMIT_BYTES : IMAGE_MIME_LIMIT_BYTES;
  if (info.size > limit) throw new Error(`Source exceeds ${limit} bytes`);
  if (info.size !== record.original.bytes) throw new Error(`Byte size is ${info.size}; manifest declares ${record.original.bytes}`);

  const bytes = await readFile(filePath);
  const digest = sha256(bytes);
  if (digest !== record.sha256) throw new Error(`SHA-256 mismatch: received ${digest}`);

  let inspected;
  if (expected.kind === "video") {
    if (!VIDEO_MIMES.has(record.original.mime)) throw new Error(`Unsupported video MIME ${record.original.mime}`);
    inspected = await inspectVideo(filePath, record.original.mime);
  } else {
    if (!IMAGE_MIMES.has(record.original.mime)) throw new Error(`Unsupported image MIME ${record.original.mime}`);
    const metadata = await sharp(bytes, { animated: false, failOn: "error" }).metadata();
    inspected = {
      mime: FORMAT_TO_MIME[metadata.format] ?? null,
      width: metadata.width,
      height: metadata.height,
    };
  }
  if (inspected.mime !== record.original.mime) throw new Error(`Detected ${inspected.mime ?? "unknown"}, declared ${record.original.mime}`);
  if (inspected.width !== record.original.width || inspected.height !== record.original.height) {
    throw new Error(`Dimensions are ${inspected.width}x${inspected.height}; manifest declares ${record.original.width}x${record.original.height}`);
  }
  return { bytes, digest, ...inspected };
}

async function normalizeImage(sourceBytes, profile, cropPosition) {
  let pipeline = sharp(sourceBytes, { animated: false, failOn: "error" })
    .rotate()
    .toColorspace("srgb");
  if (profile.fit === "contain-safe") {
    const safeWidth = Math.round(profile.width * profile.safeArea);
    const safeHeight = Math.round(profile.height * profile.safeArea);
    pipeline = pipeline
      .resize({
        width: safeWidth,
        height: safeHeight,
        fit: "contain",
        background: { r: 255, g: 255, b: 255, alpha: 1 },
        withoutEnlargement: false,
      })
      .extend({
        top: Math.floor((profile.height - safeHeight) / 2),
        bottom: Math.ceil((profile.height - safeHeight) / 2),
        left: Math.floor((profile.width - safeWidth) / 2),
        right: Math.ceil((profile.width - safeWidth) / 2),
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      });
  } else {
    pipeline = pipeline.resize({
      width: profile.width,
      height: profile.height,
      fit: "cover",
      position: cropPosition ?? "centre",
      withoutEnlargement: false,
    });
  }
  return pipeline.webp({ quality: profile.quality, effort: 5 }).toBuffer();
}

async function writeAtomic(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, filePath);
}

export async function assessAndStageAssets({
  sourceManifest,
  sourceDir,
  outputDir,
  stage = false,
  expectedAssets = buildExpectedAssets(),
}) {
  const manifestCheck = validateSourceManifest(sourceManifest, expectedAssets);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: stage ? "stage" : "readiness",
    policy: {
      networkDownloads: false,
      apiWrites: false,
      imageLimitBytes: IMAGE_MIME_LIMIT_BYTES,
      videoLimitBytes: VIDEO_MIME_LIMIT_BYTES,
    },
    manifestErrors: manifestCheck.errors,
    assets: [],
    summary: {},
  };

  for (const expected of expectedAssets) {
    const record = manifestCheck.records.get(expected.logicalKey);
    const item = {
      logicalKey: expected.logicalKey,
      kind: expected.kind,
      profile: expected.profile,
      status: "missing-source-record",
      errors: [],
    };
    if (!record) {
      report.assets.push(item);
      continue;
    }
    const recordPrefix = `assets[${sourceManifest.assets.indexOf(record)}]`;
    item.errors.push(...manifestCheck.errors.filter((error) => error.startsWith(recordPrefix)));
    if (item.errors.length) {
      item.status = "invalid-provenance";
      report.assets.push(item);
      continue;
    }
    const sourcePath = path.resolve(sourceDir, record.sourceFile);
    const sourceRelativePath = path.relative(path.resolve(sourceDir), sourcePath);
    if (sourceRelativePath.startsWith("..") || path.isAbsolute(sourceRelativePath)) {
      item.status = "invalid-provenance";
      item.errors.push("Resolved source path escapes source directory");
      report.assets.push(item);
      continue;
    }
    try {
      const validated = await validateSourceFile(sourcePath, record, expected);
      const profile = ASSET_PROFILES[expected.profile];
      const outputName = deterministicAssetFilename(
        { ...expected, mime: record.original.mime },
        validated.digest,
      );
      item.source = {
        sha256: validated.digest,
        mime: validated.mime,
        bytes: validated.bytes.length,
        width: validated.width,
        height: validated.height,
      };
      item.output = { filename: outputName };

      if (!stage) {
        item.status = "ready-to-stage";
      } else if (expected.kind === "video") {
        const outputPath = path.join(outputDir, outputName);
        await writeAtomic(outputPath, validated.bytes);
        item.status = "staged";
        item.output = { ...item.output, mime: validated.mime, bytes: validated.bytes.length, width: validated.width, height: validated.height, sha256: validated.digest };
      } else {
        const outputBytes = await normalizeImage(validated.bytes, profile, record.cropPosition);
        const metadata = await sharp(outputBytes).metadata();
        if (metadata.format !== "webp" || metadata.width !== profile.width || metadata.height !== profile.height) throw new Error("Normalized image does not match its output profile");
        if (outputBytes.length > IMAGE_MIME_LIMIT_BYTES) throw new Error("Normalized image exceeds the platform image limit");
        const outputPath = path.join(outputDir, outputName);
        await writeAtomic(outputPath, outputBytes);
        item.status = "staged";
        item.output = { ...item.output, mime: "image/webp", bytes: outputBytes.length, width: metadata.width, height: metadata.height, sha256: sha256(outputBytes) };
      }
    } catch (error) {
      item.status = "source-invalid";
      item.errors.push(error instanceof Error ? error.message : String(error));
    }
    report.assets.push(item);
  }

  report.summary = report.assets.reduce(
    (summary, asset) => {
      summary.total += 1;
      summary[asset.status] = (summary[asset.status] ?? 0) + 1;
      return summary;
    },
    { total: 0 },
  );
  report.summary.manifestErrors = report.manifestErrors.length;
  report.ready = report.manifestErrors.length === 0 && report.assets.every((asset) =>
    stage ? asset.status === "staged" : asset.status === "ready-to-stage",
  );
  return report;
}

export async function writeReadinessReport(reportPath, report) {
  await writeAtomic(reportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
}
