// The plugin registry format (docs/platform/PLUGINS.md, "Registry"): a static,
// signed index that any HTTPS host can serve, the way a package mirror or a
// browser-extension update manifest is served.
//
//   <index url>                 index.json: { version: 1, name, apps: [entry] }
//   <base>/plugin.js            each entry's packed bundle (`pnpm plugin pack`)
//   <base>/assets/<path>        its listing images (digests sealed in the bundle)
//
// `<base>` is the entry's `path`, relative to the index URL. A developer signs
// each release with an Ed25519 key over one fixed message (`signedMessage`):
// the plugin id, version, the bundle SHA-256 and the SHA-256 of the canonical
// manifest JSON. A store installs a release only when the signature verifies
// against a key it trusts: the official key (pinned in code; empty until the
// official registry exists) or a key a Super Admin added. Uploads carry the
// same signature in `signature.json`. Pure and dependency-light: the API, the
// dashboard and the `pnpm plugin` CLI share it.

import { z } from "zod";
import { PLUGIN_ID_PATTERN } from "./ids";

export const PLUGIN_REGISTRY_INDEX_VERSION = 1 as const;
/** A key id: the first 16 hex characters of the SHA-256 of the raw 32-byte public key. */
export const PLUGIN_KEY_ID = /^[0-9a-f]{16}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** A relative path under the index (no scheme, no `..`, no leading slash). */
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@/-]{1,200}$/;

export const PLUGIN_SIGNATURE_DOMAIN = "scalius-plugin-signature:v1";

/**
 * The official registry. The owner publishes it from the `scalius-plugins`
 * repository and pins its key here; until then both stay empty and the
 * dashboard says "Official registry not configured". Never put a placeholder
 * key here: an empty list trusts nothing.
 */
export const OFFICIAL_PLUGIN_REGISTRY: Readonly<{
  id: "official";
  name: string;
  indexUrl: string | null;
  keys: ReadonlyArray<PluginTrustedKey>;
}> = Object.freeze({ id: "official", name: "Scalius apps", indexUrl: null, keys: Object.freeze([]) });

export const pluginSignatureSchema = z.object({
  keyId: z.string().regex(PLUGIN_KEY_ID),
  /** Base64 of the 64-byte Ed25519 signature over `signedMessage`. */
  value: z.string().regex(BASE64).max(200),
}).strict();
export type PluginSignature = z.infer<typeof pluginSignatureSchema>;

export const pluginTrustedKeySchema = z.object({
  id: z.string().regex(PLUGIN_KEY_ID),
  /** Who the key belongs to, as the Super Admin who trusted it named it. */
  name: z.string().trim().min(1).max(80),
  /** Base64 of the raw 32-byte Ed25519 public key. */
  publicKey: z.string().regex(BASE64).max(64),
}).strict();
export type PluginTrustedKey = z.infer<typeof pluginTrustedKeySchema>;

export const pluginRegistryEntrySchema = z.object({
  id: z.string().regex(PLUGIN_ID_PATTERN),
  version: z.string().regex(SEMVER),
  /** The manifest as the developer wrote it (the store parses it again). */
  manifest: z.record(z.string(), z.unknown()),
  sha256: z.string().regex(SHA256_HEX),
  /** Bundle size in bytes (a download larger than this is refused). */
  size: z.number().int().min(1).max(16 * 1024 * 1024),
  /** Where `plugin.js` and `assets/` sit, relative to the index. */
  path: z.string().regex(RELATIVE_PATH),
  signature: pluginSignatureSchema,
}).strict();
export type PluginRegistryEntry = z.infer<typeof pluginRegistryEntrySchema>;

export const pluginRegistryIndexSchema = z.object({
  version: z.literal(PLUGIN_REGISTRY_INDEX_VERSION),
  name: z.string().trim().min(1).max(80),
  apps: z.array(pluginRegistryEntrySchema).max(2_000),
}).strict();
export type PluginRegistryIndex = z.infer<typeof pluginRegistryIndexSchema>;

/** `signature.json` in an uploaded package: the key travels with it so a Super Admin can choose to trust it. */
export const pluginPackageSignatureSchema = pluginSignatureSchema.extend({
  publicKey: z.string().regex(BASE64).max(64),
  developer: z.string().trim().min(1).max(80),
}).strict();
export type PluginPackageSignature = z.infer<typeof pluginPackageSignatureSchema>;

// ── Bytes ───────────────────────────────────────────────────────────────────

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!);
  return btoa(binary);
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** JSON with object keys sorted at every level: one byte string per manifest, whoever serialized it. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The exact bytes a release signature covers. */
export async function signedMessage(release: { id: string; version: string; sha256: string; manifest: unknown }): Promise<Uint8Array<ArrayBuffer>> {
  const manifestDigest = await sha256Hex(canonicalJson(release.manifest));
  return new TextEncoder().encode(`${PLUGIN_SIGNATURE_DOMAIN}\n${release.id}\n${release.version}\n${release.sha256}\n${manifestDigest}`);
}

export async function pluginKeyId(publicKeyBase64: string): Promise<string> {
  return (await sha256Hex(base64ToBytes(publicKeyBase64))).slice(0, 16);
}

/**
 * A key id as people compare it: `1a2b 3c4d 5e6f 7a8b`. The id is the first
 * 64 bits of the public key's SHA-256, so it identifies the key; the
 * developer name beside it is only the signer's own label. The CLI prints it
 * at keygen and pack, and the dashboard shows it before a store trusts a key.
 */
export function pluginKeyFingerprint(keyId: string): string {
  return keyId.toLowerCase().replace(/(.{4})(?=.)/g, "$1 ");
}

/** A trusted key from a public key the operator pasted or an upload carried; null when it is not a 32-byte key. */
export async function trustedKeyFrom(publicKeyBase64: string, name: string): Promise<PluginTrustedKey | null> {
  if (!BASE64.test(publicKeyBase64)) return null;
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(publicKeyBase64);
  } catch {
    return null;
  }
  if (raw.byteLength !== 32) return null;
  return { id: await pluginKeyId(publicKeyBase64), name: name.trim().slice(0, 80) || "Developer", publicKey: publicKeyBase64 };
}

export type PluginSignatureCheck =
  | { ok: true; key: PluginTrustedKey }
  | { ok: false; reason: "untrusted_key" | "bad_signature" };

/** Verifies a release signature against the trusted keys (Ed25519, WebCrypto). */
export async function verifyPluginSignature(
  release: { id: string; version: string; sha256: string; manifest: unknown },
  signature: PluginSignature,
  trustedKeys: readonly PluginTrustedKey[],
): Promise<PluginSignatureCheck> {
  const key = trustedKeys.find((candidate) => candidate.id === signature.keyId);
  if (!key) return { ok: false, reason: "untrusted_key" };
  try {
    if (await pluginKeyId(key.publicKey) !== key.id) return { ok: false, reason: "untrusted_key" };
    const publicKey = await crypto.subtle.importKey("raw", base64ToBytes(key.publicKey), { name: "Ed25519" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, base64ToBytes(signature.value), await signedMessage(release));
    return valid ? { ok: true, key } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}

/** Signs a release (the CLI and the test fixtures; never the Worker). `privateKey` is an Ed25519 CryptoKey. */
export async function signPluginRelease(
  release: { id: string; version: string; sha256: string; manifest: unknown },
  privateKey: CryptoKey,
  keyId: string,
): Promise<PluginSignature> {
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, await signedMessage(release));
  return { keyId, value: bytesToBase64(new Uint8Array(signature)) };
}

/**
 * The listing images' digests the packer sealed into a bundle's last line
 * (`//# scalius-assets {...}`), by package path; empty when it has none.
 */
export function sealedAssetDigests(code: string): Record<string, string> {
  const marker = "//# scalius-assets ";
  const at = code.lastIndexOf(marker);
  if (at === -1) return {};
  const line = code.slice(at + marker.length).split("\n", 1)[0] ?? "";
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const digests: Record<string, string> = {};
    for (const [path, digest] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof digest === "string" && SHA256_HEX.test(digest) && RELATIVE_PATH.test(path)) digests[path] = digest;
    }
    return digests;
  } catch {
    return {};
  }
}

/** Whether `candidate` is a newer semantic version than `current` (pre-releases sort before their release). */
export function isNewerPluginVersion(candidate: string, current: string): boolean {
  const parse = (value: string) => {
    const [core = "", pre] = value.split("-", 2) as [string, string | undefined];
    return { parts: core.split(".").map((part) => Number(part)), pre: pre ?? null };
  };
  const left = parse(candidate);
  const right = parse(current);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  if (left.pre === right.pre) return false;
  if (left.pre === null) return true;
  if (right.pre === null) return false;
  return left.pre > right.pre;
}
