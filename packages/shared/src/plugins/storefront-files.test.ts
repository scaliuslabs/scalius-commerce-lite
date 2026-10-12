import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "./manifest";
import { verifyStorefrontFiles } from "./storefront-files";

async function sha(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const manifest = (() => {
  const parsed = parsePluginManifest({
    id: "acme.theme", name: "Theme", version: "1.0.0", apiVersion: "2026-10", description: "A theme.", author: { name: "Acme" },
    storefront: { sections: [{ type: "hero", name: "Hero" }], islands: [{ name: "carousel" }], stylesheet: true },
  });
  if (!parsed.ok) throw new Error("manifest");
  return parsed.manifest;
})();

const text = (value: string) => new TextEncoder().encode(value);

async function release(files: Record<string, Uint8Array>, sealed: Record<string, Uint8Array> = files) {
  const digests = Object.fromEntries(await Promise.all(Object.entries(sealed).map(async ([path, bytes]) => [path, await sha(bytes)])));
  return { code: `export default 1;\n//# scalius-storefront ${JSON.stringify(digests)}\n`, read: async (path: string) => files[path] ?? null };
}

const complete = {
  "storefront.js": text("export default {}"),
  "styles.css": text(".a{}"),
  "islands/carousel.js": text("export default {}"),
  "public/mark.svg": text('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>'),
};

describe("verifyStorefrontFiles", () => {
  it("accepts a release whose files match its seal and its manifest", async () => {
    const { code, read } = await release(complete);
    expect([...(await verifyStorefrontFiles(manifest, code, read)).keys()].sort()).toEqual(Object.keys(complete).sort());
  });

  it("refuses a file that does not match its digest", async () => {
    const { code } = await release(complete);
    await expect(verifyStorefrontFiles(manifest, code, async (path) => (path === "styles.css" ? text(".b{}") : complete[path as keyof typeof complete] ?? null)))
      .rejects.toThrow(/styles\.css is missing or does not match/);
  });

  it("refuses a release missing what its manifest declares, or carrying what it does not", async () => {
    const { ["islands/carousel.js"]: _island, ...withoutIsland } = complete;
    await expect(release(withoutIsland).then(({ code, read }) => verifyStorefrontFiles(manifest, code, read))).rejects.toThrow(/islands\/carousel\.js/);
    const extra = { ...complete, "islands/other.js": text("x") };
    await expect(release(extra).then(({ code, read }) => verifyStorefrontFiles(manifest, code, read))).rejects.toThrow(/not a declared island/);
  });

  it("refuses an unsafe public file", async () => {
    const unsafe = { ...complete, "public/mark.svg": text('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>') };
    await expect(release(unsafe).then(({ code, read }) => verifyStorefrontFiles(manifest, code, read))).rejects.toThrow(/script/);
  });

  it("refuses a module over its budget", async () => {
    const big = { ...complete, "storefront.js": new Uint8Array(600 * 1024) };
    await expect(release(big).then(({ code, read }) => verifyStorefrontFiles(manifest, code, read))).rejects.toThrow(/over/);
  });
});
