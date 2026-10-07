// The generated plugin modules are fresh: the sandbox wrapper is exactly what
// `pnpm plugin build` compiles from runtime/sandbox-entry.ts and the SDK
// runtime, bundled.gen.ts plus scalius.plugins.json match what packing
// each bundled plugin produces today, and so do the listing images
// (assets.gen.ts) and the catalog of first-party plugins not bundled
// (catalog.gen.ts).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ASSETS_GEN,
  BUNDLED_GEN,
  CATALOG_GEN,
  SANDBOX_RUNTIME_GEN,
  buildSandboxRuntime,
  packForGenerated,
  packPlugin,
  readLockfile,
  renderAssetsGen,
  renderBundledGen,
  renderCatalogGen,
  renderSandboxRuntimeGen,
} from "../../../../scripts/plugin-build.mjs";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { SANDBOX_RUNTIME_MODULE } from "./sandbox-runtime.gen";

describe("generated plugin modules", () => {
  it("keeps the sandbox wrapper in step with its sources (run pnpm plugin build)", async () => {
    const code = await buildSandboxRuntime();
    expect(SANDBOX_RUNTIME_MODULE).toBe(code);
    expect(readFileSync(SANDBOX_RUNTIME_GEN, "utf8")).toBe(renderSandboxRuntimeGen(code));
    // The wrapper imports nothing but the runtime module and the plugin bundle.
    const imports = [...code.matchAll(/\bfrom\s*"([^"]+)"/g)].map((match) => match[1]).sort();
    expect(imports).toEqual(["./plugin.js", "cloudflare:workers"]);
  });

  it("keeps bundled.gen.ts and the lockfile in step with the bundled plugins (run pnpm plugin build)", async () => {
    const lockfile = readLockfile();
    expect(readFileSync(BUNDLED_GEN, "utf8")).toBe(renderBundledGen(lockfile));
    for (const plugin of lockfile.plugins) {
      const packed = await packPlugin(plugin.source);
      expect({ id: packed.id, version: packed.version, sha256: packed.sha256 }).toEqual({ id: plugin.id, version: plugin.version, sha256: plugin.sha256 });
      expect(BUNDLED_PLUGINS[plugin.id]).toMatchObject({ version: plugin.version, sha256: plugin.sha256 });
    }
  });

  it("keeps the listing images and the catalog in step with plugins/* (run pnpm plugin build)", async () => {
    const packed = await packForGenerated(readLockfile());
    expect(readFileSync(ASSETS_GEN, "utf8")).toBe(renderAssetsGen([...packed.bundled, ...packed.catalog]));
    expect(readFileSync(CATALOG_GEN, "utf8")).toBe(renderCatalogGen(packed.catalog));
  });

  it("lists every first-party app with a tagline, categories and links, in Bangla too", async () => {
    for (const plugin of readLockfile().plugins.filter((entry) => entry.source.startsWith("plugins/"))) {
      const { manifest } = await packPlugin(plugin.source);
      expect(manifest, plugin.id).toMatchObject({
        tagline: expect.any(String),
        categories: expect.arrayContaining([expect.any(String)]),
        support: { url: expect.stringMatching(/^https:\/\//) },
        changelogUrl: expect.stringMatching(/^https:\/\//),
        translations: { bn: { tagline: expect.any(String) } },
      });
    }
    // The payment apps carry their brand's logo (the listing icon and the
    // cropped checkout mark their provider declares) and serve Bangladesh only.
    for (const source of ["plugins/bkash", "plugins/nagad"]) {
      const { manifest, assets } = await packPlugin(source);
      expect(manifest, source).toMatchObject({ icon: "assets/icon.svg", countries: ["BD"] });
      expect((manifest.providers as Array<{ icon?: string }>).map((provider) => provider.icon), source).toEqual(["assets/mark.svg"]);
      expect(assets.map((asset) => asset.path).sort()).toEqual(["assets/icon.svg", "assets/mark.svg"]);
    }
  });

  it("ships every first-party app in Bangla too", async () => {
    for (const plugin of readLockfile().plugins.filter((entry) => entry.source.startsWith("plugins/"))) {
      const { manifest } = await packPlugin(plugin.source);
      expect(manifest, plugin.id).toMatchObject({ translations: { bn: { name: expect.any(String), description: expect.any(String) } } });
    }
  });
});
