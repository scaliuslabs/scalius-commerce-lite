// A test app registry (packages/plugin-sdk/docs/apps.md, "Registry"), for tests only:
// its own Ed25519 keypair made at run time (no key material in the
// repository), an index and release files served by a `fetch` stub at
// https://registry.test/, and package ZIPs for upload tests.
import {
  bytesToBase64,
  sha256Hex,
  signPluginRelease,
  trustedKeyFrom,
  type PluginRegistryEntry,
  type PluginRegistryIndex,
  type PluginTrustedKey,
} from "@scalius/shared/plugins/registry";

export const TEST_REGISTRY_INDEX_URL = "https://registry.test/index.json";

export interface TestRelease {
  manifest: Record<string, unknown>;
  /** The bundle text (the packer's output; assets sealed in its last line). */
  code: string;
  /** Listing images by manifest path. */
  assets?: Record<string, Uint8Array>;
}

export interface TestDeveloper {
  key: PluginTrustedKey;
  privateKey: CryptoKey;
}

export async function createTestDeveloper(name = "Test developer"): Promise<TestDeveloper> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { key: (await trustedKeyFrom(bytesToBase64(raw), name))!, privateKey: pair.privateKey };
}

/** A bundle text with its images' digests sealed the way `pnpm plugin build` seals them. */
export async function sealedBundle(code: string, assets: Record<string, Uint8Array> = {}): Promise<string> {
  const entries = Object.entries(assets);
  if (entries.length === 0) return code;
  const digests: Record<string, string> = {};
  for (const [path, bytes] of entries) digests[path] = await sha256Hex(bytes);
  return `${code}//# scalius-assets ${JSON.stringify(digests)}\n`;
}

export async function createTestRegistry(name = "Test registry") {
  const developer = await createTestDeveloper();
  const files = new Map<string, Uint8Array>();
  const index: PluginRegistryIndex = { version: 1, name, apps: [] };
  const encoder = new TextEncoder();
  const requests: string[] = [];

  async function publish(release: TestRelease, options: { signer?: TestDeveloper; tamper?: boolean } = {}): Promise<PluginRegistryEntry> {
    const signer = options.signer ?? developer;
    const id = String(release.manifest.id);
    const version = String(release.manifest.version);
    const code = encoder.encode(release.code);
    const sha256 = await sha256Hex(code);
    const path = `${id}/${version}`;
    const signature = await signPluginRelease({ id, version, sha256, manifest: release.manifest }, signer.privateKey, signer.key.id);
    const entry: PluginRegistryEntry = { id, version, manifest: release.manifest, sha256, size: code.byteLength, path, signature };
    files.set(`${path}/plugin.js`, options.tamper ? encoder.encode(`${release.code.slice(0, -1)}${release.code.endsWith("x") ? "y" : "x"}`) : code);
    for (const [assetPath, bytes] of Object.entries(release.assets ?? {})) files.set(`${path}/assets/${assetPath}`, bytes);
    index.apps = [...index.apps.filter((existing) => !(existing.id === id && existing.version === version)), entry];
    return entry;
  }

  const fetchStub = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.href);
    if (url.host !== "registry.test") return new Response("not found", { status: 404 });
    if (url.pathname === "/index.json") return new Response(JSON.stringify(index), { headers: { "Content-Type": "application/json" } });
    const file = files.get(url.pathname.slice(1));
    return file ? new Response(file as Uint8Array<ArrayBuffer>) : new Response("not found", { status: 404 });
  };

  return { developer, index, publish, fetch: fetchStub, requests, indexUrl: TEST_REGISTRY_INDEX_URL };
}

// ── Package ZIPs ───────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP of stored (uncompressed) files, as a minimal archiver writes it. */
export function storedZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directorySize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directorySize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An upload package for a release: manifest.json, plugin.js, assets/ and, when signed, signature.json. */
export async function testPackage(release: TestRelease, signer?: TestDeveloper): Promise<Uint8Array> {
  const files: Record<string, Uint8Array | string> = {
    "manifest.json": JSON.stringify(release.manifest),
    "plugin.js": release.code,
  };
  for (const [path, bytes] of Object.entries(release.assets ?? {})) files[`assets/${path}`] = bytes;
  if (signer) {
    const id = String(release.manifest.id);
    const version = String(release.manifest.version);
    const sha256 = await sha256Hex(new TextEncoder().encode(release.code));
    const signature = await signPluginRelease({ id, version, sha256, manifest: release.manifest }, signer.privateKey, signer.key.id);
    files["signature.json"] = JSON.stringify({ ...signature, publicKey: signer.key.publicKey, developer: signer.key.name });
  }
  return storedZip(files);
}
