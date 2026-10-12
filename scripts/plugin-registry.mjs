// Registry authoring and installs for `pnpm plugin` (docs/platform/PLUGINS.md,
// "Registry"). The signed format lives in packages/shared/src/plugins/registry.ts;
// this file only calls it, it never re-implements signing or verifying.
//
// - keygen:  an Ed25519 signing key for a developer;
// - pack:    `dist/` plus `signature.json` and a `<id>-<version>.zip` upload package;
// - index:   a static registry folder (index.json + each release's files);
// - install: download one release from a registry, check its SHA-256 and
//            signature, and write it as a local package that `pnpm plugin add`
//            then bundles (the Workers Free install path).

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import {
  loadEsbuild,
  loadPluginContract,
  packPlugin,
  pluginPackageDir,
  readLockfile,
  root,
} from "./plugin-build.mjs";

/** The most files a package may hold (the API reader's limit) and the largest bundle a registry lists. */
export const PACKAGE_MAX_ENTRIES = 64;
export const PACKAGE_MAX_BYTES = 20 * 1024 * 1024;
export const BUNDLE_MAX_BYTES = 16 * 1024 * 1024;

// ── Arguments ────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set(["--dir", "--key", "--developer", "--out", "--name", "--base-url", "--registry", "--version", "--plan"]);

/** Splits `pnpm plugin` arguments into positionals and flags, so a flag's value is never mistaken for a path. */
export function parseCommandArgs(args) {
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      if (VALUE_FLAGS.has(arg)) {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
        flags.set(arg, value);
        index += 1;
      } else {
        flags.set(arg, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** A path the user typed, relative to where they ran `pnpm plugin` (pnpm sets INIT_CWD). */
export function userPath(path, env = process.env) {
  return resolve(env.INIT_CWD || process.cwd(), path);
}

// ── Contract ─────────────────────────────────────────────────────────────

let registryContract = null;

/** The signed registry format (packages/shared/src/plugins/registry.ts) compiled for Node. */
export async function loadRegistryContract() {
  if (registryContract) return registryContract;
  const esbuild = await loadEsbuild();
  const result = await esbuild.build({
    stdin: {
      contents: 'export * from "@scalius/shared/plugins/registry";\nexport { sealedStorefrontDigests, STOREFRONT_FILE_PATH, STOREFRONT_COMPONENT_LIMITS } from "@scalius/shared/plugins/storefront-components";',
      resolveDir: join(root, "packages/plugin-sdk"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  registryContract = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  return registryContract;
}

let permissionCheck;

/**
 * Which permissions exist and which a plugin may hold (packages/core grants).
 * Null when that module cannot be loaded from a script; callers then say so.
 */
export async function loadPermissionCheck() {
  if (permissionCheck !== undefined) return permissionCheck;
  try {
    const esbuild = await loadEsbuild();
    const grants = join(root, "packages/core/src/modules/plugins/grants.ts");
    const result = await esbuild.build({
      stdin: {
        contents: `export { isKnownPermission, isPluginGrantablePermission } from ${JSON.stringify(grants)};`,
        resolveDir: root,
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    const loaded = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
    permissionCheck = { isKnownPermission: loaded.isKnownPermission, isPluginGrantablePermission: loaded.isPluginGrantablePermission };
  } catch {
    permissionCheck = null;
  }
  return permissionCheck;
}

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ── Keys ─────────────────────────────────────────────────────────────────

function toPem(der) {
  const body = Buffer.from(der).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

/** Writes a new Ed25519 signing key to `<outDir>/signing-key.pem` (mode 0600) and returns its public half. */
export async function generateSigningKey(outDir) {
  const registry = await loadRegistryContract();
  const keyFile = join(outDir, "signing-key.pem");
  if (existsSync(keyFile)) throw new Error(`${keyFile} already exists; it was not overwritten.`);
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(keyFile, toPem(pkcs8), { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return { keyFile, publicKey, keyId: await registry.pluginKeyId(publicKey) };
}

/** Reads a PKCS#8 PEM signing key: the signing CryptoKey, its base64 raw public key and its key id. */
export async function readSigningKey(pemPath) {
  const registry = await loadRegistryContract();
  let pem;
  try {
    pem = readFileSync(pemPath, "utf8");
  } catch {
    throw new Error(`Cannot read the signing key ${pemPath}. Make one with: pnpm plugin keygen <folder>`);
  }
  let privateKey;
  let publicKey;
  try {
    const der = Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
    privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    const jwk = createPublicKey(createPrivateKey(pem)).export({ format: "jwk" });
    publicKey = Buffer.from(jwk.x, "base64url").toString("base64");
  } catch {
    throw new Error(`${pemPath} is not an Ed25519 private key in PKCS#8 PEM form (the file pnpm plugin keygen writes).`);
  }
  return { privateKey, publicKey, keyId: await registry.pluginKeyId(publicKey) };
}

// ── ZIP ──────────────────────────────────────────────────────────────────

const ZIP_TIME = 0; // 00:00:00
const ZIP_DATE = (1 << 5) | 1; // 1980-01-01, so the same files always make the same bytes

/**
 * A ZIP archive of `files` (`[path, bytes]` pairs): stored or deflated
 * entries, no ZIP64, no extra fields. What apps/api/src/plugins/package-zip.ts
 * reads.
 */
export function writeZip(files) {
  if (files.length > PACKAGE_MAX_ENTRIES) throw new Error(`A package holds at most ${PACKAGE_MAX_ENTRIES} files; this one has ${files.length}.`);
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const bytes = Buffer.from(data);
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(bytes, { level: 9 });
    const stored = deflated.length >= bytes.length;
    const body = stored ? bytes : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(ZIP_TIME, 10);
    local.writeUInt16LE(ZIP_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(ZIP_TIME, 12);
    entry.writeUInt16LE(ZIP_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...locals, directory, end]);
  if (zip.length > PACKAGE_MAX_BYTES) throw new Error("The package is larger than 20 MiB, the most a store accepts.");
  return zip;
}

// ── Pack ─────────────────────────────────────────────────────────────────

/**
 * Packs a plugin (dist/plugin.js, dist/manifest.json, dist/assets/*) and
 * writes what a registry or an upload needs on top: `dist/signature.json`
 * when a key is given, and `dist/<id>-<version>.zip`.
 */
export async function packSigned(source, { key = null, developer = null } = {}) {
  const registry = await loadRegistryContract();
  const packed = await packPlugin(source);
  const dist = join(pluginPackageDir(source), "dist");
  const manifestText = readFileSync(join(dist, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const code = readFileSync(join(dist, "plugin.js"));
  const sha256 = sha256Of(code);
  if (code.length > BUNDLE_MAX_BYTES) throw new Error(`The bundle is ${(code.length / 1024 / 1024).toFixed(1)} MiB; a registry lists at most 16 MiB.`);
  const files = [
    ["manifest.json", Buffer.from(manifestText)],
    ["plugin.js", code],
    ...packed.assets.map((asset) => [`assets/${asset.path}`, Buffer.from(asset.bytes)]),
    ...packed.storefront.map((file) => [`storefront/${file.path}`, Buffer.from(file.bytes)]),
  ];
  const signaturePath = join(dist, "signature.json");
  rmSync(signaturePath, { force: true });
  let signature = null;
  if (key) {
    const signing = await readSigningKey(key);
    const signed = await registry.signPluginRelease({ id: manifest.id, version: manifest.version, sha256, manifest }, signing.privateKey, signing.keyId);
    signature = registry.pluginPackageSignatureSchema.parse({
      keyId: signed.keyId,
      value: signed.value,
      publicKey: signing.publicKey,
      developer: (developer ?? manifest.author?.name ?? "").trim() || "Developer",
    });
    writeFileSync(signaturePath, `${JSON.stringify(signature, null, 2)}\n`);
    files.push(["signature.json", Buffer.from(`${JSON.stringify(signature, null, 2)}\n`)]);
  }
  const zipPath = join(dist, `${manifest.id}-${manifest.version}.zip`);
  writeFileSync(zipPath, writeZip(files));
  return { id: manifest.id, version: manifest.version, sha256, dist, zipPath, signature, files: files.map(([name]) => name) };
}

// ── Index ────────────────────────────────────────────────────────────────

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function compareVersions(registry, left, right) {
  if (left === right) return 0;
  return registry.isNewerPluginVersion(left, right) ? 1 : -1;
}

/**
 * Builds or extends a static registry folder from signed `dist` folders
 * (`pnpm plugin pack --key`). Same id and version replaces its entry. Returns
 * the index written and the entries added.
 */
export async function buildRegistry(distDirs, { out, name = null }) {
  const registry = await loadRegistryContract();
  if (distDirs.length === 0) throw new Error("Give at least one packed dist folder (pnpm plugin pack <path> --key <pem>).");
  const indexPath = join(out, "index.json");
  let index = null;
  if (existsSync(indexPath)) {
    const parsed = registry.pluginRegistryIndexSchema.safeParse(JSON.parse(readFileSync(indexPath, "utf8")));
    if (!parsed.success) throw new Error(`${indexPath} exists but is not a Scalius registry index; it was not changed.`);
    index = parsed.data;
  }
  const registryName = name ?? index?.name;
  if (!registryName) throw new Error("A new registry needs a name: --name \"Acme apps\".");
  const added = [];
  for (const dist of distDirs) {
    const read = (file) => {
      try {
        return readFileSync(join(dist, file));
      } catch {
        throw new Error(`${dist}: ${file} is missing. Pack the plugin with a key first: pnpm plugin pack <path> --key <pem>`);
      }
    };
    const manifestBytes = read("manifest.json");
    const code = read("plugin.js");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const packageSignature = registry.pluginPackageSignatureSchema.safeParse(JSON.parse(read("signature.json").toString("utf8")));
    if (!packageSignature.success) throw new Error(`${dist}: signature.json is not a Scalius package signature.`);
    const sha256 = sha256Of(code);
    // The key travels with the package; the signature must match it, the code and the manifest.
    const key = await registry.trustedKeyFrom(packageSignature.data.publicKey, packageSignature.data.developer);
    if (!key || key.id !== packageSignature.data.keyId) throw new Error(`${dist}: signature.json names a key that does not match its public key.`);
    const signature = { keyId: packageSignature.data.keyId, value: packageSignature.data.value };
    const check = await registry.verifyPluginSignature({ id: manifest.id, version: manifest.version, sha256, manifest }, signature, [key]);
    if (!check.ok) throw new Error(`${dist}: the signature does not match plugin.js and manifest.json. Pack and sign it again.`);
    if (code.length < 1 || code.length > BUNDLE_MAX_BYTES) throw new Error(`${dist}: plugin.js must be between 1 byte and 16 MiB.`);
    const sealed = registry.sealedAssetDigests(code.toString("utf8"));
    const assetFiles = listFiles(join(dist, "assets"));
    for (const [path, digest] of Object.entries(sealed)) {
      const file = join(dist, "assets", path);
      if (!existsSync(file) || sha256Of(readFileSync(file)) !== digest) throw new Error(`${dist}: assets/${path} is missing or does not match the bundle. Pack it again.`);
    }
    const storefront = registry.sealedStorefrontDigests(code.toString("utf8"));
    for (const [path, digest] of Object.entries(storefront)) {
      const file = join(dist, "storefront", path);
      if (!existsSync(file) || sha256Of(readFileSync(file)) !== digest) throw new Error(`${dist}: storefront/${path} is missing or does not match the bundle. Pack it again.`);
    }
    const entry = { id: manifest.id, version: manifest.version, manifest, sha256, size: code.length, path: `${manifest.id}/${manifest.version}`, signature };
    const base = join(out, entry.path);
    rmSync(base, { recursive: true, force: true });
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "plugin.js"), code);
    for (const file of assetFiles) {
      const target = join(base, "assets", relative(join(dist, "assets"), file));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(file));
    }
    for (const path of Object.keys(storefront)) {
      const target = join(base, "storefront", path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(dist, "storefront", path)));
    }
    index = {
      version: 1,
      name: registryName,
      apps: [...(index?.apps ?? []).filter((app) => !(app.id === entry.id && app.version === entry.version)), entry],
    };
    added.push(entry);
  }
  const next = registry.pluginRegistryIndexSchema.parse({
    version: 1,
    name: registryName,
    apps: [...index.apps].sort((left, right) => left.id.localeCompare(right.id) || compareVersions(registry, left.version, right.version)),
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(indexPath, `${JSON.stringify(next, null, 2)}\n`);
  return { index: next, added };
}

// ── Install from a registry ──────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;
const INDEX_MAX_BYTES = 2 * 1024 * 1024;
const ASSET_MAX_BYTES = 1024 * 1024;

/** https only; plain http just for this machine (tests and local registries). */
export function checkRegistryUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${value} is not a full address (https://example.com/index.json).`);
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("A registry address must start with https:// (http:// is allowed only for localhost).");
  }
  return url;
}

async function download(url, maxBytes, fetchImpl) {
  checkRegistryUrl(url);
  let response;
  try {
    response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new Error(`${new URL(url).host} did not answer.`);
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`${url} is larger than the ${maxBytes} bytes its listing allows.`);
  return bytes;
}

/** The newest listed release of `id`, or the named version. */
export function pickRelease(registry, index, id, version) {
  const entries = index.apps.filter((entry) => entry.id === id);
  if (version) return entries.find((entry) => entry.version === version) ?? null;
  return entries.reduce((best, entry) => (!best || registry.isNewerPluginVersion(entry.version, best.version) ? entry : best), null);
}

/** The package folder name of a plugin id: `acme.tally` is `acme-tally`. */
export const packageFolderName = (id) => id.replace(".", "-");

/**
 * Downloads one release, checks it and writes it as a local package
 * (`<pluginsDir>/<vendor>-<name>/`): package.json, plugin.js, manifest.json and
 * its listing images. Trusts the official registry's keys and the lockfile's
 * `trustedKeys`, nothing else. `pnpm plugin add <dir>` then bundles it.
 */
export async function installFromRegistry({ id, indexUrl, version = null, pluginsDir, lockfilePath, fetchImpl = fetch }) {
  const registry = await loadRegistryContract();
  const contract = await loadPluginContract();
  checkRegistryUrl(indexUrl);
  const indexBytes = await download(indexUrl, INDEX_MAX_BYTES, fetchImpl);
  let json;
  try {
    json = JSON.parse(indexBytes.toString("utf8"));
  } catch {
    throw new Error("The registry index is not JSON.");
  }
  const parsedIndex = registry.pluginRegistryIndexSchema.safeParse(json);
  if (!parsedIndex.success) throw new Error("The registry index is not in the Scalius registry format.");
  const index = parsedIndex.data;
  const entry = pickRelease(registry, index, id, version);
  if (!entry) throw new Error(`${id}${version ? `@${version}` : ""} is not in the registry "${index.name}".`);

  const releaseUrl = (file) => new URL(`${entry.path.replace(/\/+$/, "")}/${file}`, indexUrl).href;
  const code = await download(releaseUrl("plugin.js"), entry.size, fetchImpl);
  const sha256 = sha256Of(code);
  if (sha256 !== entry.sha256) throw new Error("The downloaded code does not match the registry's SHA-256. Nothing was installed.");

  const trustedKeys = [...registry.OFFICIAL_PLUGIN_REGISTRY.keys, ...(readLockfile(lockfilePath).trustedKeys ?? [])];
  const check = await registry.verifyPluginSignature({ id: entry.id, version: entry.version, sha256, manifest: entry.manifest }, entry.signature, trustedKeys);
  if (!check.ok) {
    if (check.reason === "untrusted_key") {
      throw new Error(`${entry.id} is signed with key ${entry.signature.keyId}, which this store does not trust. If you know who owns it, add it with: pnpm plugin trust <name> <public key>`);
    }
    throw new Error("The signature does not match the code and manifest. Do not install this release. Nothing was installed.");
  }

  const parsed = contract.parsePluginManifest(entry.manifest);
  if (!parsed.ok) throw new Error(`The release's manifest is invalid: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  if (parsed.manifest.id !== entry.id || parsed.manifest.version !== entry.version) throw new Error("The release's manifest names another app or version than its listing.");
  const compatible = contract.pluginCompatibility(entry.manifest);
  if (!compatible.ok) throw new Error(compatible.message);

  const assets = [];
  for (const [path, digest] of Object.entries(registry.sealedAssetDigests(code.toString("utf8")))) {
    const bytes = await download(releaseUrl(`assets/${path}`), ASSET_MAX_BYTES, fetchImpl);
    if (sha256Of(bytes) !== digest) throw new Error(`${path} does not match the bundle. Nothing was installed.`);
    assets.push({ path, bytes });
  }

  // Storefront files: compiled by the developer, installed as they are (`storefront/`), checked against the sealed digests.
  const storefront = [];
  for (const [path, digest] of Object.entries(registry.sealedStorefrontDigests(code.toString("utf8")))) {
    const limits = registry.STOREFRONT_COMPONENT_LIMITS;
    const bytes = await download(releaseUrl(`storefront/${path}`), Math.max(limits.moduleBytes, limits.publicFileBytes), fetchImpl);
    if (sha256Of(bytes) !== digest) throw new Error(`storefront/${path} does not match the bundle. Nothing was installed.`);
    storefront.push({ path, bytes });
  }

  const directory = join(pluginsDir, packageFolderName(entry.id));
  const marker = join(directory, "package.json");
  if (existsSync(directory)) {
    let installedFromRegistry = false;
    try {
      installedFromRegistry = JSON.parse(readFileSync(marker, "utf8")).scalius?.registry !== undefined;
    } catch {
      // Not a package folder: refused below.
    }
    if (!installedFromRegistry) throw new Error(`${directory} already exists and was not installed from a registry; move it first.`);
    rmSync(directory, { recursive: true, force: true });
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(marker, `${JSON.stringify({
    name: `@scalius/plugin-${packageFolderName(entry.id)}`,
    version: entry.version,
    private: true,
    type: "module",
    exports: { ".": "./plugin.js" },
    scalius: { registry: indexUrl, id: entry.id, sha256, keyId: entry.signature.keyId, signer: check.key.name },
  }, null, 2)}\n`);
  writeFileSync(join(directory, "plugin.js"), code);
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(entry.manifest, null, 2)}\n`);
  for (const asset of assets) {
    const target = join(directory, asset.path);
    if (relative(directory, target).startsWith("..")) throw new Error(`Unsafe asset path ${asset.path}.`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, asset.bytes);
  }
  for (const file of storefront) {
    const target = join(directory, "storefront", file.path);
    if (relative(directory, target).startsWith("..") || !registry.STOREFRONT_FILE_PATH.test(file.path)) throw new Error(`Unsafe storefront path ${file.path}.`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
  return { directory, id: entry.id, version: entry.version, sha256, signer: check.key, registryName: index.name };
}

/** Adds a developer key to the lockfile's `trustedKeys` content. */
export async function trustedKeysWith(lockfile, name, publicKey) {
  const registry = await loadRegistryContract();
  const key = await registry.trustedKeyFrom(publicKey, name);
  if (!key) throw new Error("That is not a public key: give the base64 text of a raw 32-byte Ed25519 key (pnpm plugin keygen prints it).");
  return { key, trustedKeys: [...(lockfile.trustedKeys ?? []).filter((existing) => existing.id !== key.id), key] };
}
