// `pnpm plugin` registry authoring and installs: keys, signed packs, upload
// ZIPs the API reads, a static registry, and installs from a local server.
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPluginPackageZip } from "../apps/api/src/plugins/package-zip.ts";
import { verifyRelease } from "../apps/api/src/plugins/releases.ts";
import { packPlugin, readLockfile, renderLockfile } from "./plugin-build.mjs";
import {
  buildRegistry,
  checkRegistryUrl,
  generateSigningKey,
  installFromRegistry,
  loadRegistryContract,
  packSigned,
  parseCommandArgs,
  trustedKeysWith,
  writeZip,
} from "./plugin-registry.mjs";
import { editSource, makeTempPlugin } from "./plugin-test-helpers.mjs";

const scratch = [];
const scratchDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "scalius-plugin-registry-"));
  scratch.push(dir);
  return dir;
};
const read = (...parts) => readFileSync(join(...parts));

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("pnpm plugin arguments", () => {
  it("keeps a flag's value out of the positionals", () => {
    const { positional, flags } = parseCommandArgs(["acme.tally", "--registry", "https://r.example/index.json", "--local", "--version", "1.2.0"]);
    expect(positional).toEqual(["acme.tally"]);
    expect(flags.get("--registry")).toBe("https://r.example/index.json");
    expect(flags.get("--version")).toBe("1.2.0");
    expect(flags.get("--local")).toBe(true);
    expect(() => parseCommandArgs(["pack", "--key"])).toThrow("--key needs a value");
  });
});

describe("zip writer", () => {
  it("writes archives the API reader reads back byte for byte, stored or deflated", async () => {
    const small = Buffer.from("x");
    const big = Buffer.from("export default 1;\n".repeat(500));
    const binary = Buffer.from(Array.from({ length: 300 }, (_, index) => (index * 37) % 256));
    const files = await readPluginPackageZip(writeZip([["manifest.json", small], ["plugin.js", big], ["assets/assets/icon.png", binary]]));
    expect([...files.keys()]).toEqual(["manifest.json", "plugin.js", "assets/assets/icon.png"]);
    expect(Buffer.from(files.get("plugin.js"))).toEqual(big);
    expect(Buffer.from(files.get("manifest.json"))).toEqual(small);
    expect(Buffer.from(files.get("assets/assets/icon.png"))).toEqual(binary);
  });

  it("makes the same bytes for the same files and refuses more files than a store reads", () => {
    const entries = [["a.txt", Buffer.from("a")], ["b.txt", Buffer.from("b")]];
    expect(writeZip(entries).equals(writeZip(entries))).toBe(true);
    expect(() => writeZip(Array.from({ length: 65 }, (_, index) => [`f${index}.txt`, Buffer.from("x")]))).toThrow("at most 64 files");
  });
});

describe("keys, signed packs and the upload ZIP", () => {
  let plugin;
  let keyDir;
  let key;
  let registry;
  beforeAll(async () => {
    registry = await loadRegistryContract();
    plugin = makeTempPlugin({ withIcon: true });
    keyDir = scratchDir();
    key = await generateSigningKey(keyDir);
  });
  afterAll(() => plugin?.cleanup());

  it("makes a private key only its owner can read, and names the public one", async () => {
    expect(statSync(key.keyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(key.keyFile, "utf8")).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(Buffer.from(key.publicKey, "base64")).toHaveLength(32);
    expect(key.keyId).toBe(await registry.pluginKeyId(key.publicKey));
    expect(key.keyId).toMatch(/^[0-9a-f]{16}$/);
    await expect(generateSigningKey(keyDir)).rejects.toThrow("already exists");
  });

  it("signs exactly the files it writes, and the ZIP carries them at the root", async () => {
    const packed = await packSigned(plugin.dir, { key: key.keyFile, developer: "Acme Ltd" });
    const dist = join(plugin.dir, "dist");
    const manifestText = read(dist, "manifest.json").toString("utf8");
    const manifest = JSON.parse(manifestText);
    expect(packed.sha256).toBe((await registry.sha256Hex(read(dist, "plugin.js"))));

    const signature = registry.pluginPackageSignatureSchema.parse(JSON.parse(read(dist, "signature.json").toString("utf8")));
    expect(signature).toMatchObject({ keyId: key.keyId, publicKey: key.publicKey, developer: "Acme Ltd" });
    const trusted = await registry.trustedKeyFrom(key.publicKey, "Acme Ltd");
    expect(await registry.verifyPluginSignature({ id: manifest.id, version: manifest.version, sha256: packed.sha256, manifest }, signature, [trusted])).toMatchObject({ ok: true });

    const files = await readPluginPackageZip(readFileSync(packed.zipPath));
    expect([...files.keys()].sort()).toEqual(["assets/assets/icon.svg", "manifest.json", "plugin.js", "signature.json", "storefront/storefront.js"]);
    expect(Buffer.from(files.get("manifest.json")).toString("utf8")).toBe(manifestText);
    expect(Buffer.from(files.get("plugin.js"))).toEqual(read(dist, "plugin.js"));
    expect(Buffer.from(files.get("signature.json"))).toEqual(read(dist, "signature.json"));
    expect(Buffer.from(files.get("assets/assets/icon.svg"))).toEqual(read(dist, "assets/assets/icon.svg"));
    expect(Buffer.from(files.get("storefront/storefront.js"))).toEqual(read(dist, "storefront/storefront.js"));
  });

  it("passes the API's own release check when read back from the ZIP (the upload path)", async () => {
    const packed = await packSigned(plugin.dir, { key: key.keyFile });
    const files = await readPluginPackageZip(readFileSync(packed.zipPath));
    const signature = JSON.parse(Buffer.from(files.get("signature.json")).toString("utf8"));
    const trusted = await registry.trustedKeyFrom(signature.publicKey, signature.developer);
    const release = await verifyRelease({
      manifest: JSON.parse(Buffer.from(files.get("manifest.json")).toString("utf8")),
      code: files.get("plugin.js"),
      signature: { keyId: signature.keyId, value: signature.value },
      trustedKeys: [trusted],
      asset: async (path) => files.get(`assets/${path}`) ?? null,
      storefrontFile: async (path) => files.get(`storefront/${path}`) ?? null,
      source: "upload",
    });
    expect(release.manifest.id).toBe("acme.tally");
    expect([...release.assets.keys()]).toEqual(["assets/icon.svg"]);
    expect([...release.storefront.keys()]).toEqual(["storefront.js"]);
    expect(release.signer?.id).toBe(key.keyId);
  });

  it("defaults the developer to the manifest author, and an unsigned pack drops any old signature", async () => {
    const signed = await packSigned(plugin.dir, { key: key.keyFile });
    expect(signed.signature.developer).toBe("acme");
    // --key takes the folder keygen wrote, too.
    expect((await packSigned(plugin.dir, { key: keyDir })).signature.keyId).toBe(signed.signature.keyId);
    const unsigned = await packSigned(plugin.dir);
    expect(unsigned.signature).toBeNull();
    expect(existsSync(join(plugin.dir, "dist/signature.json"))).toBe(false);
    const files = await readPluginPackageZip(readFileSync(unsigned.zipPath));
    expect(files.has("signature.json")).toBe(false);
  });

  it("explains an unreadable key", async () => {
    await expect(packSigned(plugin.dir, { key: join(keyDir, "missing.pem") })).rejects.toThrow("pnpm plugin keygen");
    const bad = join(scratchDir(), "bad.pem");
    writeFileSync(bad, "not a key");
    await expect(packSigned(plugin.dir, { key: bad })).rejects.toThrow("not an Ed25519 private key");
  });
});

const TYPES = { ".json": "application/json", ".js": "text/javascript", ".svg": "image/svg+xml" };

function serve(directory) {
  const server = createServer((request, response) => {
    const path = join(directory, decodeURIComponent(new URL(request.url, "http://x").pathname));
    if (!path.startsWith(directory) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

describe("static registry and installs", () => {
  let registry;
  let plugin;
  let key;
  let otherKey;
  let dist1;
  let dist2;
  let unsignedDist;
  let out;
  let http;

  beforeAll(async () => {
    registry = await loadRegistryContract();
    key = await generateSigningKey(scratchDir());
    otherKey = await generateSigningKey(scratchDir());
    plugin = makeTempPlugin({ withIcon: true, version: "1.0.0" });
    dist1 = scratchDir();
    dist2 = scratchDir();
    unsignedDist = scratchDir();
    await packSigned(plugin.dir, { key: key.keyFile, developer: "Acme Ltd" });
    cpSync(join(plugin.dir, "dist"), dist1, { recursive: true });
    await packSigned(plugin.dir);
    cpSync(join(plugin.dir, "dist"), unsignedDist, { recursive: true });
    editSource(plugin.dir, (source) => source.replace('version: "1.0.0"', 'version: "1.1.0"'));
    await packSigned(plugin.dir, { key: key.keyFile, developer: "Acme Ltd" });
    cpSync(join(plugin.dir, "dist"), dist2, { recursive: true });
    out = scratchDir();
    await buildRegistry([dist1, dist2], { out, name: "Acme apps" });
    http = await serve(out);
  });
  afterAll(async () => {
    plugin?.cleanup();
    await new Promise((resolve) => http?.server.close(resolve));
  });

  const lockfileWith = (keys) => {
    const path = join(scratchDir(), "scalius.plugins.json");
    writeFileSync(path, renderLockfile({ version: 1, sandbox: false, plugins: [], trustedKeys: keys }));
    return path;
  };
  const trusted = async () => [await registry.trustedKeyFrom(key.publicKey, "Acme Ltd")];

  it("lists each signed release with its files under <id>/<version>", () => {
    const index = registry.pluginRegistryIndexSchema.parse(JSON.parse(read(out, "index.json").toString("utf8")));
    expect(index.name).toBe("Acme apps");
    expect(index.apps.map((app) => [app.id, app.version, app.path])).toEqual([
      ["acme.tally", "1.0.0", "acme.tally/1.0.0"],
      ["acme.tally", "1.1.0", "acme.tally/1.1.0"],
    ]);
    const first = index.apps[0];
    expect(first.size).toBe(read(out, "acme.tally/1.0.0/plugin.js").length);
    expect(first.manifest).toEqual(JSON.parse(read(dist1, "manifest.json").toString("utf8")));
    expect(first.signature.keyId).toBe(key.keyId);
    expect(readdirSync(join(out, "acme.tally/1.0.0/assets/assets"))).toEqual(["icon.svg"]);
  });

  it("merges into an existing index, replacing the same release", async () => {
    const before = JSON.parse(read(out, "index.json").toString("utf8"));
    const result = await buildRegistry([dist2], { out });
    expect(result.index.apps).toHaveLength(2);
    expect(result.index.name).toBe("Acme apps");
    expect(JSON.parse(read(out, "index.json").toString("utf8"))).toEqual(before);
  });

  it("refuses an unsigned pack, a tampered pack and a new registry without a name", async () => {
    await expect(buildRegistry([unsignedDist], { out: scratchDir(), name: "x" })).rejects.toThrow("signature.json is missing");
    const tampered = scratchDir();
    cpSync(dist1, tampered, { recursive: true });
    writeFileSync(join(tampered, "plugin.js"), `${read(tampered, "plugin.js")}\n// sneaky`);
    await expect(buildRegistry([tampered], { out: scratchDir(), name: "x" })).rejects.toThrow("does not match plugin.js and manifest.json");
    await expect(buildRegistry([dist1], { out: scratchDir() })).rejects.toThrow("needs a name");
  });

  it("installs the newest signed release as a local package that packs again", async () => {
    const pluginsDir = scratchDir();
    const installed = await installFromRegistry({
      id: "acme.tally",
      indexUrl: `${http.url}/index.json`,
      pluginsDir,
      lockfilePath: lockfileWith(await trusted()),
    });
    expect(installed).toMatchObject({ id: "acme.tally", version: "1.1.0", directory: join(pluginsDir, "acme-tally") });
    const pkg = JSON.parse(read(installed.directory, "package.json").toString("utf8"));
    expect(pkg).toMatchObject({ name: "@scalius/plugin-acme-tally", private: true, type: "module", exports: { ".": "./plugin.js" } });
    expect(read(installed.directory, "plugin.js")).toEqual(read(out, "acme.tally/1.1.0/plugin.js"));
    expect(JSON.parse(read(installed.directory, "manifest.json").toString("utf8")).version).toBe("1.1.0");
    expect(read(installed.directory, "assets/icon.svg").toString("utf8")).toContain("<svg");

    // The existing `add` flow packs this folder: a pre-built bundle, its icon beside it.
    const repacked = await packPlugin(installed.directory);
    expect(repacked).toMatchObject({ id: "acme.tally", version: "1.1.0" });
    expect(repacked.assets.map((asset) => asset.path)).toEqual(["assets/icon.svg"]);
    expect(registry.sealedAssetDigests(repacked.code)).toEqual({ "assets/icon.svg": repacked.assets[0].sha256 });

    // Installing again replaces the folder it made.
    await expect(installFromRegistry({ id: "acme.tally", indexUrl: `${http.url}/index.json`, version: "1.0.0", pluginsDir, lockfilePath: lockfileWith(await trusted()) }))
      .resolves.toMatchObject({ version: "1.0.0" });
    expect(JSON.parse(read(installed.directory, "manifest.json").toString("utf8")).version).toBe("1.0.0");
  });

  it("refuses a key the lockfile does not trust, then accepts it once trusted", async () => {
    const pluginsDir = scratchDir();
    await expect(installFromRegistry({ id: "acme.tally", indexUrl: `${http.url}/index.json`, pluginsDir, lockfilePath: lockfileWith([]) }))
      .rejects.toThrow(`key ${key.keyId}, which this store does not trust`);
    expect(existsSync(join(pluginsDir, "acme-tally"))).toBe(false);
    await expect(installFromRegistry({ id: "acme.tally", indexUrl: `${http.url}/index.json`, pluginsDir, lockfilePath: lockfileWith([await registry.trustedKeyFrom(otherKey.publicKey, "Someone else")]) }))
      .rejects.toThrow("does not trust");
    const { trustedKeys } = await trustedKeysWith({ trustedKeys: [] }, "Acme Ltd", key.publicKey);
    const path = lockfileWith(trustedKeys);
    expect(readLockfile(path).trustedKeys).toEqual([{ id: key.keyId, name: "Acme Ltd", publicKey: key.publicKey }]);
    await expect(installFromRegistry({ id: "acme.tally", indexUrl: `${http.url}/index.json`, pluginsDir, lockfilePath: path })).resolves.toMatchObject({ signer: { id: key.keyId } });
  });

  it("refuses code that changed after it was indexed, and a manifest rewritten in the index", async () => {
    const copy = scratchDir();
    cpSync(out, copy, { recursive: true });
    const lockfilePath = lockfileWith(await trusted());
    const altered = await serve(copy);
    try {
      const code = read(copy, "acme.tally/1.1.0/plugin.js");
      code[0] ^= 1; // the same size, one byte different
      writeFileSync(join(copy, "acme.tally/1.1.0/plugin.js"), code);
      await expect(installFromRegistry({ id: "acme.tally", indexUrl: `${altered.url}/index.json`, pluginsDir: scratchDir(), lockfilePath }))
        .rejects.toThrow("does not match the registry's SHA-256");

      cpSync(join(out, "acme.tally/1.1.0/plugin.js"), join(copy, "acme.tally/1.1.0/plugin.js"));
      const index = JSON.parse(read(copy, "index.json").toString("utf8"));
      index.apps[1].manifest.description = "Now it does something else.";
      writeFileSync(join(copy, "index.json"), JSON.stringify(index));
      await expect(installFromRegistry({ id: "acme.tally", indexUrl: `${altered.url}/index.json`, pluginsDir: scratchDir(), lockfilePath }))
        .rejects.toThrow("signature does not match");
    } finally {
      await new Promise((resolve) => altered.server.close(resolve));
    }
  });

  it("refuses a changed listing image, an unknown app or version, and a folder it did not make", async () => {
    const lockfilePath = lockfileWith(await trusted());
    const copy = scratchDir();
    cpSync(out, copy, { recursive: true });
    const altered = await serve(copy);
    try {
      writeFileSync(join(copy, "acme.tally/1.1.0/assets/assets/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
      await expect(installFromRegistry({ id: "acme.tally", indexUrl: `${altered.url}/index.json`, pluginsDir: scratchDir(), lockfilePath }))
        .rejects.toThrow("does not match the bundle");
    } finally {
      await new Promise((resolve) => altered.server.close(resolve));
    }
    await expect(installFromRegistry({ id: "acme.other", indexUrl: `${http.url}/index.json`, pluginsDir: scratchDir(), lockfilePath })).rejects.toThrow('is not in the registry "Acme apps"');
    await expect(installFromRegistry({ id: "acme.tally", version: "9.9.9", indexUrl: `${http.url}/index.json`, pluginsDir: scratchDir(), lockfilePath })).rejects.toThrow("acme.tally@9.9.9");
    const pluginsDir = scratchDir();
    mkdirSync(join(pluginsDir, "acme-tally"));
    writeFileSync(join(pluginsDir, "acme-tally/package.json"), JSON.stringify({ name: "mine" }));
    await expect(installFromRegistry({ id: "acme.tally", indexUrl: `${http.url}/index.json`, pluginsDir, lockfilePath })).rejects.toThrow("was not installed from a registry");
  });

  it("accepts http only for this machine", () => {
    expect(() => checkRegistryUrl("http://registry.example.com/index.json")).toThrow("https://");
    expect(() => checkRegistryUrl("ftp://registry.example.com/index.json")).toThrow("https://");
    expect(() => checkRegistryUrl("not a url")).toThrow("full address");
    expect(checkRegistryUrl("https://registry.example.com/index.json").hostname).toBe("registry.example.com");
    expect(checkRegistryUrl("http://localhost:8787/index.json").hostname).toBe("localhost");
    expect(checkRegistryUrl("http://127.0.0.1:1/index.json").hostname).toBe("127.0.0.1");
  });

  it("refuses a key that is not 32 bytes of base64", async () => {
    await expect(trustedKeysWith({ trustedKeys: [] }, "Nobody", "AAAA")).rejects.toThrow("not a public key");
    await expect(trustedKeysWith({ trustedKeys: [] }, "Nobody", "not base64!")).rejects.toThrow("not a public key");
  });

  it("keeps trusted keys when the lockfile is rendered, sorted by id, and drops the field when empty", () => {
    const lockfile = { version: 1, sandbox: false, plugins: [], trustedKeys: [
      { id: "bbbbbbbbbbbbbbbb", name: "B", publicKey: "QQ==" },
      { id: "aaaaaaaaaaaaaaaa", name: "A", publicKey: "QQ==" },
    ] };
    expect(JSON.parse(renderLockfile(lockfile)).trustedKeys.map((entry) => entry.id)).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    expect("trustedKeys" in JSON.parse(renderLockfile({ ...lockfile, trustedKeys: [] }))).toBe(false);
  });
});
