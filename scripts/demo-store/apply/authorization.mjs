import { createHash } from "node:crypto";

import { assertValidDemoStoreManifest } from "../validate.mjs";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalDemoApplyIntent(manifest, publicationIntent = {}) {
  assertValidDemoStoreManifest(manifest);
  return canonicalize({ manifest, publicationIntent });
}

export function demoApplyIntentFingerprint(manifest, publicationIntent = {}) {
  const canonical = canonicalDemoApplyIntent(manifest, publicationIntent);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function assertDemoApplyAuthorization({
  authorization,
  manifest,
  publicationIntent = {},
}) {
  const fingerprint = demoApplyIntentFingerprint(manifest, publicationIntent);
  if (authorization?.confirmed !== true || authorization.intentFingerprint !== fingerprint) {
    throw new Error("Apply authorization does not match the complete demo-store intent.");
  }
  return fingerprint;
}
