// App releases from a registry or an uploaded package (packages/plugin-sdk/docs/apps.md,
// "Registry"): download, verify, store, then install or update. Every release
// goes through the same checks before anything is stored:
//
//   1. the bundle's SHA-256 (the index's, or the one the signature covers);
//   2. the plugin API version and platform release (`pluginCompatibility`);
//   3. the manifest as an install would take it (`requireInstallableManifest`);
//   4. the Ed25519 signature over id, version, SHA-256 and manifest digest,
//      against the keys the store trusts (an upload may be unsigned, or signed
//      by a new developer, only after a Super Admin's explicit trust);
//   5. each listing image against the digest sealed in the bundle.
//
// Then the bundle and images go to R2 under the private prefix, and the
// installation is written. Sandboxed installs need Workers Paid; on Free the
// Apps page shows `pnpm plugin add <id>` instead.

import {
  PluginError,
  installPlugin,
  pluginRegistrySettingsDocument,
  pluginRegistrySources,
  requireInstallableManifest,
  trustedPluginKeys,
  type PluginInstallation,
  type PluginRegistrySettings,
} from "@scalius/core/modules/plugins";
import type { Database } from "@scalius/database/client";
import { checkOutboundUrl } from "@scalius/shared/outbound-url";
import { pluginCompatibility, type PluginManifest } from "@scalius/shared/plugins";
import { checkPluginAsset } from "@scalius/shared/plugins/assets";
import { verifyStorefrontFiles } from "@scalius/shared/plugins/storefront-files";
import { STOREFRONT_COMPONENT_LIMITS, storefrontFileContentType } from "@scalius/shared/plugins/storefront-protocol";
import {
  isNewerPluginVersion,
  pluginPackageSignatureSchema,
  pluginRegistryIndexSchema,
  sealedAssetDigests,
  sha256Hex,
  trustedKeyFrom,
  verifyPluginSignature,
  type PluginRegistryEntry,
  type PluginRegistryIndex,
  type PluginSignature,
  type PluginTrustedKey,
} from "@scalius/shared/plugins/registry";
import { pluginAssetKey } from "./listing";
import { pluginBundleKey } from "./loaders/sandbox";
import { pluginStorefrontFileKey, pluginStorefrontIndexKey } from "./storefront-files";

/** The largest storefront file a registry download reads. */
const STOREFRONT_FILE_MAX_BYTES = Math.max(STOREFRONT_COMPONENT_LIMITS.moduleBytes, STOREFRONT_COMPONENT_LIMITS.publicFileBytes);

const INDEX_MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** A verified release, ready to store and install. */
export interface PluginRelease {
  manifest: PluginManifest;
  sha256: string;
  code: Uint8Array;
  /** Listing images by package path, each checked against its sealed digest. */
  assets: Map<string, Uint8Array>;
  /** Storefront files by path under `storefront/`, each checked against its sealed digest (storefront-files.ts). */
  storefront: Map<string, Uint8Array>;
  /** The trusted key that verified it; null for an unsigned upload a Super Admin accepted. */
  signer: PluginTrustedKey | null;
}

// ── Fetching ───────────────────────────────────────────────────────────────

const MAX_REGISTRY_REDIRECTS = 3;

/** A public https:// address, or the registry error: every hop (redirects too) passes the outbound guard. */
function registryUrl(url: string): URL {
  const checked = checkOutboundUrl(url);
  if (!checked.ok || checked.url.protocol !== "https:") {
    throw new PluginError("registry_unavailable", "Registry addresses must be public https:// addresses.");
  }
  return checked.url;
}

async function fetchBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  let target = registryUrl(url);
  const checked = { url: target };
  let response: Response;
  for (let hop = 0; ; hop += 1) {
    try {
      response = await fetch(target.href, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      throw new PluginError("registry_unavailable", `${target.host} did not answer.`);
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("Location") : null;
    if (!location) break;
    await response.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REGISTRY_REDIRECTS) throw new PluginError("registry_unavailable", `${target.host} redirected too many times.`);
    let next: string;
    try {
      next = new URL(location, target).href;
    } catch {
      throw new PluginError("registry_unavailable", `${target.host} redirected to an invalid address.`);
    }
    target = registryUrl(next);
    checked.url = target;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new PluginError(response.status === 404 ? "registry_not_found" : "registry_unavailable", `${checked.url.host} answered ${response.status}.`);
  }
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new PluginError("registry_unavailable", "The download is larger than allowed.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PluginError("registry_unavailable", "The download is larger than allowed.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** One registry's index, validated (never trusted for anything but listing until a release verifies). */
export async function fetchRegistryIndex(indexUrl: string): Promise<PluginRegistryIndex> {
  const bytes = await fetchBytes(indexUrl, INDEX_MAX_BYTES);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PluginError("registry_unavailable", "The registry index is not JSON.");
  }
  const parsed = pluginRegistryIndexSchema.safeParse(json);
  if (!parsed.success) throw new PluginError("registry_unavailable", "The registry index is not in the Scalius registry format.");
  return parsed.data;
}

function releaseUrl(indexUrl: string, entry: PluginRegistryEntry, file: string): string {
  return new URL(`${entry.path.replace(/\/+$/, "")}/${file}`, indexUrl).href;
}

// ── Verification ───────────────────────────────────────────────────────────

/** The package paths of the listing images a manifest names (icon, screenshots, provider icons). */
function listingAssetPaths(manifest: PluginManifest): Array<{ path: string; role: "icon" | "screenshot" }> {
  return [
    ...(manifest.icon ? [{ path: manifest.icon, role: "icon" as const }] : []),
    ...manifest.screenshots.map((path) => ({ path, role: "screenshot" as const })),
    ...manifest.providers.flatMap((provider) => (provider.icon ? [{ path: provider.icon, role: "icon" as const }] : [])),
  ];
}

export interface VerifyReleaseInput {
  /** The manifest as published (the signature covers its canonical JSON). */
  manifest: unknown;
  code: Uint8Array;
  /** The SHA-256 the index promises (registry); an upload has none. */
  expectedSha256?: string;
  /** Who it claims to be (registry entry); checked against the manifest. */
  expectedId?: string;
  expectedVersion?: string;
  signature: PluginSignature | null;
  trustedKeys: readonly PluginTrustedKey[];
  /** The listing images, or a reader for them (registry downloads). */
  asset: (path: string) => Promise<Uint8Array | null>;
  /** The storefront files (`storefront/<path>` in a package), or a reader for them; none without it. */
  storefrontFile?: (path: string) => Promise<Uint8Array | null>;
  source: "registry" | "upload";
  /** Uploads only: a Super Admin accepted this release without a signature. */
  allowUnsigned?: boolean;
}

export async function verifyRelease(input: VerifyReleaseInput): Promise<PluginRelease> {
  const sha256 = await sha256Hex(input.code);
  if (input.expectedSha256 !== undefined && sha256 !== input.expectedSha256) {
    throw new PluginError("package_hash_mismatch", "The downloaded code does not match the registry's SHA-256.");
  }
  const compatible = pluginCompatibility(input.manifest);
  if (!compatible.ok) throw new PluginError("installation_incompatible", compatible.message, { reason: compatible.reason });
  const manifest = requireInstallableManifest(input.manifest, input.source);
  if ((input.expectedId && manifest.id !== input.expectedId) || (input.expectedVersion && manifest.version !== input.expectedVersion)) {
    throw new PluginError("package_invalid", "The release's manifest names another app or version than its listing.");
  }
  let signer: PluginTrustedKey | null = null;
  if (input.signature) {
    const check = await verifyPluginSignature({ id: manifest.id, version: manifest.version, sha256, manifest: input.manifest }, input.signature, input.trustedKeys);
    if (!check.ok) {
      throw check.reason === "untrusted_key"
        ? new PluginError("signature_untrusted", "The release is signed by a developer this store does not trust.", { keyId: input.signature.keyId })
        : new PluginError("signature_invalid", "The release's signature does not match its code and manifest. Do not install it.");
    }
    signer = check.key;
  } else if (!(input.source === "upload" && input.allowUnsigned)) {
    throw new PluginError("signature_missing", "The release is not signed.");
  }
  const sealed = sealedAssetDigests(new TextDecoder().decode(input.code));
  const assets = new Map<string, Uint8Array>();
  for (const { path, role } of listingAssetPaths(manifest)) {
    if (assets.has(path)) continue;
    const digest = sealed[path];
    if (!digest) throw new PluginError("package_invalid", `The bundle does not seal the digest of ${path}; pack it with pnpm plugin pack.`);
    const bytes = await input.asset(path);
    if (!bytes || await sha256Hex(bytes) !== digest) throw new PluginError("package_invalid", `${path} is missing or does not match the bundle.`);
    const problem = checkPluginAsset(path, bytes, role);
    if (problem) throw new PluginError("package_invalid", problem);
    assets.set(path, bytes);
  }
  let storefront: Map<string, Uint8Array>;
  try {
    storefront = await verifyStorefrontFiles(manifest, new TextDecoder().decode(input.code), input.storefrontFile ?? (async () => null));
  } catch (error) {
    throw new PluginError("package_invalid", error instanceof Error ? error.message : "The storefront files do not match the bundle.");
  }
  return { manifest, sha256, code: input.code, assets, storefront, signer };
}

/** Stores a verified release's bundle and images in R2 (private prefix), where the sandbox loader and the image route read them. */
export async function storeRelease(env: Env, release: PluginRelease): Promise<void> {
  const { manifest, sha256 } = release;
  await env.BUCKET.put(pluginBundleKey(manifest.id, manifest.version, sha256), release.code, {
    httpMetadata: { contentType: "text/javascript" },
  });
  for (const [path, bytes] of release.assets) {
    await env.BUCKET.put(pluginAssetKey(manifest.id, manifest.version, sha256, path), bytes);
  }
  if (release.storefront.size > 0) {
    // The files first, then their index: the file route serves nothing until the index names it.
    const digests: Record<string, string> = {};
    for (const [path, bytes] of release.storefront) {
      await env.BUCKET.put(pluginStorefrontFileKey(manifest.id, manifest.version, sha256, path), bytes, {
        httpMetadata: { contentType: storefrontFileContentType(path) ?? "application/octet-stream" },
      });
      digests[path] = await sha256Hex(bytes);
    }
    await env.BUCKET.put(pluginStorefrontIndexKey(manifest.id, manifest.version, sha256), JSON.stringify(digests), {
      httpMetadata: { contentType: "application/json" },
    });
  }
}

// ── Registry ───────────────────────────────────────────────────────────────

export async function readRegistrySettings(db: Database): Promise<PluginRegistrySettings> {
  return pluginRegistrySettingsDocument.read(db);
}

/** Downloads and verifies one release listed by a configured registry. */
export async function downloadRegistryRelease(
  db: Database,
  request: { registryId: string; id: string; version?: string },
): Promise<PluginRelease> {
  const settings = await readRegistrySettings(db);
  const sources = pluginRegistrySources(settings);
  if (sources.length === 0) throw new PluginError("registry_not_configured", "No app registry is configured. The official registry is not configured yet.");
  const source = sources.find((candidate) => candidate.id === request.registryId);
  if (!source) throw new PluginError("registry_not_found", `No registry ${request.registryId}.`);
  const index = await fetchRegistryIndex(source.indexUrl);
  const entry = latestEntry(index, request.id, request.version);
  if (!entry) throw new PluginError("registry_not_found", `${request.id}${request.version ? `@${request.version}` : ""} is not in ${source.name}.`);
  const code = await fetchBytes(releaseUrl(source.indexUrl, entry, "plugin.js"), entry.size);
  return verifyRelease({
    manifest: entry.manifest,
    code,
    expectedSha256: entry.sha256,
    expectedId: entry.id,
    expectedVersion: entry.version,
    signature: entry.signature,
    trustedKeys: trustedPluginKeys(settings),
    asset: (path) => fetchBytes(releaseUrl(source.indexUrl, entry, `assets/${path}`), 1024 * 1024).catch(() => null),
    storefrontFile: (path) => fetchBytes(releaseUrl(source.indexUrl, entry, `storefront/${path}`), STOREFRONT_FILE_MAX_BYTES).catch(() => null),
    source: "registry",
  });
}

/** The entry for an app: the named version, else the newest listed one. */
export function latestEntry(index: PluginRegistryIndex, id: string, version?: string): PluginRegistryEntry | null {
  const entries = index.apps.filter((entry) => entry.id === id);
  if (version) return entries.find((entry) => entry.version === version) ?? null;
  return entries.reduce<PluginRegistryEntry | null>((best, entry) => (!best || isNewerPluginVersion(entry.version, best.version) ? entry : best), null);
}

// ── Upload ─────────────────────────────────────────────────────────────────

export interface UploadTrust {
  /** A Super Admin accepted an unsigned package (it shows as unsigned). */
  allowUnsigned: boolean;
  /** A Super Admin chose to trust the package's developer key (it is added to the trusted keys). */
  trustDeveloper: boolean;
}

/**
 * Verifies an uploaded package. Returns the release and, when the Super
 * Admin chose to trust a new developer, the key to add to the trusted keys
 * (the caller saves it with the install).
 */
export async function verifyUploadedPackage(
  db: Database,
  files: Map<string, Uint8Array>,
  trust: UploadTrust,
): Promise<{ release: PluginRelease; newKey: PluginTrustedKey | null }> {
  const read = (name: string) => files.get(name) ?? null;
  const manifestBytes = read("manifest.json");
  const code = read("plugin.js");
  if (!manifestBytes || !code) throw new PluginError("package_invalid", "A package holds manifest.json and plugin.js (pnpm plugin pack writes both).");
  const parseJson = (bytes: Uint8Array, name: string): unknown => {
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new PluginError("package_invalid", `${name} is not JSON.`);
    }
  };
  const manifest = parseJson(manifestBytes, "manifest.json");
  const signatureBytes = read("signature.json");
  const settings = await readRegistrySettings(db);
  let trustedKeys = trustedPluginKeys(settings);
  let signature: PluginSignature | null = null;
  let newKey: PluginTrustedKey | null = null;
  if (signatureBytes) {
    const parsed = pluginPackageSignatureSchema.safeParse(parseJson(signatureBytes, "signature.json"));
    if (!parsed.success) throw new PluginError("package_invalid", "signature.json is not a Scalius package signature.");
    const packageKey = await trustedKeyFrom(parsed.data.publicKey, parsed.data.developer);
    if (!packageKey || packageKey.id !== parsed.data.keyId) throw new PluginError("signature_invalid", "signature.json names a key that does not match its public key.");
    signature = { keyId: parsed.data.keyId, value: parsed.data.value };
    if (!trustedKeys.some((key) => key.id === packageKey.id)) {
      if (!trust.trustDeveloper) {
        throw new PluginError("signature_untrusted", `Signed by ${packageKey.name}, a developer this store does not trust yet.`, {
          keyId: packageKey.id,
          developer: packageKey.name,
        });
      }
      newKey = packageKey;
      trustedKeys = [...trustedKeys, packageKey];
    }
  }
  const release = await verifyRelease({
    manifest,
    code,
    signature,
    trustedKeys,
    asset: async (path) => read(`assets/${path}`),
    storefrontFile: async (path) => read(`storefront/${path}`),
    source: "upload",
    allowUnsigned: trust.allowUnsigned,
  });
  return { release, newKey };
}

/** Adds a developer key a Super Admin chose to trust (idempotent). */
export async function trustDeveloperKey(db: Database, key: PluginTrustedKey): Promise<void> {
  const current = await pluginRegistrySettingsDocument.readDetailed(db);
  if (current.value.trustedKeys.some((existing) => existing.id === key.id)) return;
  await pluginRegistrySettingsDocument.write(
    db,
    { trustedKeys: [...current.value.trustedKeys, key] },
    undefined,
    { expectedRevision: current.revision },
  );
}

// ── Install ────────────────────────────────────────────────────────────────

/** Installs a verified, stored release as a new app (status installed: nothing runs until a Super Admin approves it). */
export async function installRelease(
  db: Database,
  release: PluginRelease,
  options: { source: "registry" | "upload"; actorUserId: string | null },
): Promise<PluginInstallation> {
  return installPlugin(db, {
    manifest: release.manifest,
    source: options.source,
    bundleSha256: release.sha256,
    actorUserId: options.actorUserId,
    signerKeyId: release.signer?.id ?? null,
  });
}

/** Whether a listed release is newer than the installed version. */
export function hasUpdate(installed: PluginInstallation, entry: PluginRegistryEntry): boolean {
  return entry.id === installed.pluginId && isNewerPluginVersion(entry.version, installed.version);
}
