import { createHash } from "node:crypto";

import { createApplyBinder } from "../apply-bind.mjs";
import { assertStagedAssetReadiness } from "../apply-readiness.mjs";
import { buildDemoStoreDiff } from "../diff.mjs";
import { createDemoLifecycleRuntime } from "./runtime.mjs";
import { assertRetainedProductAuthority } from "./retained-authority.mjs";

function exactMap(rows, field, label) {
  const result = new Map();
  for (const row of rows ?? []) {
    if (!row?.[field] || result.has(row[field])) throw new Error(`${label} identity is missing or ambiguous: ${row?.[field] ?? "<missing>"}.`);
    result.set(row[field], row);
  }
  return result;
}

export function assertFreshApplySnapshot(snapshot, now = new Date(), maxAgeMs = 5 * 60_000) {
  const capturedAt = Date.parse(snapshot?.capturedAt ?? "");
  if (!Number.isFinite(capturedAt) || now.getTime() - capturedAt > maxAgeMs || capturedAt > now.getTime() + 30_000) {
    throw new Error("Demo apply requires a fresh authenticated snapshot.");
  }
  return snapshot;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function snapshotAuthorityFingerprint(snapshot) {
  const authority = Object.fromEntries(Object.entries(snapshot ?? {}).filter(([key]) => !["capturedAt", "auth"].includes(key)));
  return createHash("sha256").update(JSON.stringify(canonicalize(authority))).digest("hex");
}

export function assertCompleteRemoteMediaReadiness(manifest, report, snapshot) {
  const readiness = assertStagedAssetReadiness(manifest, report);
  if (report?.evidence?.productsMutated !== false || report?.evidence?.publicationMutated !== false
    || report?.evidence?.uploadOrder !== "sequential") {
    throw new Error("Remote Media readiness does not contain the fail-closed upload bridge evidence.");
  }
  const remoteById = exactMap(snapshot?.media, "id", "Fresh remote Media");
  const videos = report.assets.filter((asset) => asset.kind === "video");
  if (report.evidence.posterLinksVerified !== videos.length) {
    throw new Error("Remote Media readiness poster-link evidence is incomplete.");
  }
  for (const asset of report.assets) {
    let mediaUrl;
    try { mediaUrl = new URL(asset.url); } catch { throw new Error(`${asset.logicalKey} remote Media URL is invalid.`); }
    if (mediaUrl.protocol !== "https:" || mediaUrl.username || mediaUrl.password) {
      throw new Error(`${asset.logicalKey} remote Media URL must be credential-free HTTPS.`);
    }
    if (!["uploaded", "adopted", "resumed", "retained-reuse"].includes(asset.importAction)) {
      throw new Error(`${asset.logicalKey} does not prove a remote Media import action.`);
    }
    const remote = remoteById.get(asset.mediaId);
    if (!remote || remote.status !== "ready" || remote.kind !== asset.kind
      || remote.filename !== asset.filename || remote.url !== asset.url || remote.size !== asset.size
      || remote.width !== asset.width || remote.height !== asset.height) {
      throw new Error(`${asset.logicalKey} does not match the fresh remote Media projection.`);
    }
    if (asset.kind === "video") {
      if (!asset.posterLogicalKey || !asset.posterMediaId || remote.posterMediaId !== asset.posterMediaId) {
        throw new Error(`${asset.logicalKey} does not have its verified remote poster relationship.`);
      }
      const poster = readiness.assets.get(asset.posterLogicalKey);
      if (poster?.mediaId !== asset.posterMediaId || poster.kind !== "image") {
        throw new Error(`${asset.logicalKey} poster readiness is inconsistent.`);
      }
    }
  }
  return readiness;
}

function finalVerificationIntents(lifecycle) {
  const ready = lifecycle.phases.filter((phase) => phase.state === "ready").flatMap((phase) => phase.commands);
  const categoryStatus = new Map(ready.filter((command) => command.logicalKey.endsWith(":publish"))
    .map((command) => [command.logicalKey.replace(/:publish$/u, ""), command.body.status]));
  const productActivations = new Map(ready.filter((command) => command.logicalKey.startsWith("product:") && command.logicalKey.endsWith(":activate"))
    .map((command) => [command.logicalKey.replace(/:activate$/u, ":base"), command]));
  const collectionActivations = new Set(ready.filter((command) => command.logicalKey.startsWith("collection:") && command.logicalKey.endsWith(":activate"))
    .map((command) => command.logicalKey.replace(/:activate$/u, "")));
  const heroActivations = new Set(ready.filter((command) => command.logicalKey.startsWith("hero-slider:") && command.logicalKey.endsWith(":activate"))
    .map((command) => command.logicalKey.replace(/:activate$/u, "")));
  const result = [];
  for (const command of ready) {
    if (command.phase === "quarantine" || command.logicalKey.endsWith(":publish") || command.logicalKey.endsWith(":activate")) continue;
    if (productActivations.has(command.logicalKey)) continue;
    let body = command.body;
    if (categoryStatus.has(command.logicalKey)) body = { ...body, status: categoryStatus.get(command.logicalKey) };
    if (collectionActivations.has(command.logicalKey) || heroActivations.has(command.logicalKey)) body = { ...body, isActive: true };
    result.push({ ...command, body });
  }
  result.push(...productActivations.values());
  return result;
}

function assertFinalDiff(diff) {
  const groups = Object.values(diff.resources);
  const incomplete = groups.flat().filter((resource) => resource.action !== "match");
  if (diff.summary.conflicts > 0 || incomplete.length) {
    throw new Error(`Final demo-store diff disagrees for ${incomplete.map((item) => item.logicalKey).join(", ") || "conflicting resources"}.`);
  }
}

export async function verifyDemoApplyDesiredState({
  manifest,
  readinessReport,
  lifecycle,
  snapshot,
  outputs,
  readClient,
  now = new Date(),
}) {
  assertFreshApplySnapshot(snapshot, now);
  const readiness = assertCompleteRemoteMediaReadiness(manifest, readinessReport, snapshot);
  assertRetainedProductAuthority(manifest, snapshot, readiness);
  const binder = createApplyBinder({ manifest, readiness, snapshot, outputs });
  const runtime = createDemoLifecycleRuntime(readClient);
  const verified = [];
  for (const intent of finalVerificationIntents(lifecycle)) {
    const command = binder.bind(intent);
    const current = await runtime.resolveCurrent(command);
    if (!current || !await runtime.matchesDesired(command, current)) {
      throw new Error(`Final desired-state verification disagreed for ${intent.logicalKey}.`);
    }
    verified.push(intent.logicalKey);
  }
  const diff = buildDemoStoreDiff(manifest, snapshot);
  assertFinalDiff(diff);
  return { status: "verified", verifiedCommands: verified.length, diff };
}
