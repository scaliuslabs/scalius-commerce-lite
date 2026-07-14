#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { registerGeneratedAssets } from "./generated-registration.mjs";

const confirmationFlags = new Map([
  ["--confirm-no-watermark", "noWatermark"],
  ["--confirm-no-visible-branding", "noVisibleBranding"],
  ["--confirm-no-trademarked-character", "noTrademarkedCharacter"],
  ["--confirm-no-identifiable-endorser", "noIdentifiableEndorser"],
  ["--confirm-option-appearance", "optionAppearanceVerified"],
]);
const valueFlags = new Set([
  "--manifest", "--source-dir", "--file", "--logical-key", "--prompt", "--prompt-file",
  "--model", "--creator", "--rights-url", "--reviewed-by", "--acquired-at", "--verified-at",
  "--crop-position", "--retained-product-id", "--replaces-media-id",
]);

function usage() {
  return [
    "Usage: register-generated.mjs --manifest PRIVATE_PATH --source-dir PRIVATE_DIR --file FILE",
    "  --logical-key EXACT_KEY [--logical-key EXACT_KEY ...]",
    "  (--prompt TEXT | --prompt-file FILE) --model MODEL --creator CREATOR --rights-url HTTPS_URL",
    "  --reviewed-by REVIEWER --acquired-at YYYY-MM-DD --verified-at YYYY-MM-DD",
    "  [--retained-product-id PRODUCT_ID --replaces-media-id CURRENT_MEDIA_ID]",
    "  --confirm-no-watermark --confirm-no-visible-branding --confirm-no-trademarked-character",
    "  --confirm-no-identifiable-endorser --confirm-option-appearance [--crop-position POSITION]",
  ].join("\n");
}

export function parseGeneratedRegistrationArgs(argv) {
  const options = { logicalKeys: [], confirmations: {}, cropPosition: "centre" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (confirmationFlags.has(arg)) {
      options.confirmations[confirmationFlags.get(arg)] = true;
      continue;
    }
    if (!valueFlags.has(arg)) throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    const value = argv[++index];
    if (!value) throw new Error(`${arg} needs a value`);
    if (arg === "--logical-key") options.logicalKeys.push(value);
    else options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!options.manifest || !options.sourceDir || !options.file) throw new Error(`Private manifest, source directory, and file are required\n${usage()}`);
  if (options.logicalKeys.length === 0) throw new Error(`At least one --logical-key is required\n${usage()}`);
  if (Boolean(options.prompt) === Boolean(options.promptFile)) throw new Error("Use exactly one of --prompt or --prompt-file");
  for (const field of ["model", "creator", "rightsUrl", "reviewedBy", "acquiredAt", "verifiedAt"]) {
    if (!options[field]) throw new Error(`${field} is required\n${usage()}`);
  }
  for (const reviewField of confirmationFlags.values()) {
    if (!options.confirmations[reviewField]) throw new Error(`Every visual-rights confirmation is required; missing ${reviewField}`);
  }
  if (Boolean(options.retainedProductId) !== Boolean(options.replacesMediaId)) {
    throw new Error("Retained replacement requires both --retained-product-id and --replaces-media-id");
  }
  if (options.retainedProductId && options.logicalKeys.length !== 1) {
    throw new Error("Retained replacement registration accepts exactly one logical key");
  }
  return options;
}

async function main() {
  const options = parseGeneratedRegistrationArgs(process.argv.slice(2));
  const prompt = options.prompt ?? await readFile(path.resolve(options.promptFile), "utf8");
  const result = await registerGeneratedAssets({
    manifestPath: path.resolve(options.manifest),
    sourceDir: path.resolve(options.sourceDir),
    sourceFile: path.resolve(options.file),
    logicalKeys: options.logicalKeys,
    prompt,
    model: options.model,
    creator: options.creator,
    rightsUrl: options.rightsUrl,
    acquiredAt: options.acquiredAt,
    verifiedAt: options.verifiedAt,
    cropPosition: options.cropPosition,
    rightsReview: {
      reviewedBy: options.reviewedBy,
      ...options.confirmations,
    },
    ...(options.retainedProductId ? {
      retainedReplacement: {
        productId: options.retainedProductId,
        mediaId: options.replacesMediaId,
      },
    } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    manifest: result.manifestPath,
    logicalKeys: result.logicalKeys,
    source: result.source,
    assetCount: result.assetCount,
    policy: { network: false, apiWrites: false },
  }, null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
