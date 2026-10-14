import { describe, expect, it } from "vitest";
import {
  OFFICIAL_PLUGIN_REGISTRY,
  bytesToBase64,
  canonicalJson,
  isNewerPluginVersion,
  pluginRegistryIndexSchema,
  sealedAssetDigests,
  sha256Hex,
  signPluginRelease,
  signedMessage,
  trustedKeyFrom,
  verifyPluginSignature,
  type PluginTrustedKey,
} from "./registry";

/** A developer keypair made for this test only; no key material lives in the repository. */
async function developer(name = "Acme") {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const key = (await trustedKeyFrom(bytesToBase64(raw), name))!;
  return { key, privateKey: pair.privateKey };
}

const manifest = { id: "acme.points", name: "Points", version: "1.2.0", apiVersion: "2026-10", description: "d", author: { name: "Acme" } };
const release = { id: "acme.points", version: "1.2.0", sha256: "c".repeat(64), manifest };

describe("plugin registry signatures", () => {
  it("ships no official key until the owner publishes one", () => {
    expect(OFFICIAL_PLUGIN_REGISTRY.indexUrl).toBeNull();
    expect(OFFICIAL_PLUGIN_REGISTRY.keys).toEqual([]);
  });

  it("serializes a manifest the same way whatever the key order", async () => {
    expect(canonicalJson({ b: 1, a: [{ d: true, c: null }], e: undefined })).toBe("{\"a\":[{\"c\":null,\"d\":true}],\"b\":1}");
    const reordered = { author: { name: "Acme" }, version: "1.2.0", description: "d", apiVersion: "2026-10", name: "Points", id: "acme.points" };
    expect(await signedMessage({ ...release, manifest: reordered })).toEqual(await signedMessage(release));
  });

  it("verifies a release signed by a trusted key and refuses anything changed", async () => {
    const { key, privateKey } = await developer();
    const signature = await signPluginRelease(release, privateKey, key.id);
    expect(await verifyPluginSignature(release, signature, [key])).toEqual({ ok: true, key });
    expect(await verifyPluginSignature({ ...release, sha256: "d".repeat(64) }, signature, [key])).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyPluginSignature({ ...release, manifest: { ...manifest, scopes: ["write_orders"] } }, signature, [key]))
      .toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyPluginSignature({ ...release, version: "1.2.1" }, signature, [key])).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a key the store does not trust, and a trusted name pinned to another key", async () => {
    const signer = await developer();
    const other = await developer("Other");
    const signature = await signPluginRelease(release, signer.privateKey, signer.key.id);
    expect(await verifyPluginSignature(release, signature, [other.key])).toEqual({ ok: false, reason: "untrusted_key" });
    // A stored key whose id does not derive from its public key trusts nothing.
    const forged: PluginTrustedKey = { ...other.key, id: signer.key.id };
    expect(await verifyPluginSignature(release, signature, [forged])).toEqual({ ok: false, reason: "untrusted_key" });
  });

  it("derives key ids from 32-byte public keys only", async () => {
    expect(await trustedKeyFrom(bytesToBase64(new Uint8Array(31)), "Short")).toBeNull();
    expect(await trustedKeyFrom("not base64!", "Bad")).toBeNull();
    const key = await trustedKeyFrom(bytesToBase64(new Uint8Array(32)), "  Zero  ");
    expect(key).toEqual({ id: (await sha256Hex(new Uint8Array(32))).slice(0, 16), name: "Zero", publicKey: bytesToBase64(new Uint8Array(32)) });
  });

  it("reads the asset digests a bundle seals, and nothing else", () => {
    const digest = "e".repeat(64);
    expect(sealedAssetDigests(`export default {};\n//# scalius-assets {"assets/icon.svg":"${digest}","../x":"${digest}","assets/bad.png":"nothex"}\n`))
      .toEqual({ "assets/icon.svg": digest });
    expect(sealedAssetDigests("export default {};\n")).toEqual({});
    expect(sealedAssetDigests("//# scalius-assets {not json")).toEqual({});
  });

  it("orders versions semantically, pre-releases before their release", () => {
    expect(isNewerPluginVersion("1.10.0", "1.9.9")).toBe(true);
    expect(isNewerPluginVersion("1.2.0", "1.2.0")).toBe(false);
    expect(isNewerPluginVersion("1.2.0", "1.2.0-beta.1")).toBe(true);
    expect(isNewerPluginVersion("1.2.0-beta.1", "1.2.0")).toBe(false);
    expect(isNewerPluginVersion("0.9.0", "1.0.0")).toBe(false);
  });

  it("accepts only relative release paths in an index", () => {
    const entry = { id: "acme.points", version: "1.2.0", manifest, sha256: "c".repeat(64), size: 10, signature: { keyId: "0".repeat(16), value: "AAAA" } };
    const parse = (path: string) => pluginRegistryIndexSchema.safeParse({ version: 1, name: "Acme", apps: [{ ...entry, path }] }).success;
    expect(parse("acme.points/1.2.0")).toBe(true);
    expect(parse("../secrets")).toBe(false);
    expect(parse("https://evil.example/x")).toBe(false);
    expect(parse("/absolute")).toBe(false);
  });
});
