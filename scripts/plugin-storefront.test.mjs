import { describe, expect, it } from "vitest";
import { packPlugin, sealStorefront } from "./plugin-build.mjs";
import { editSource, makeTempPlugin } from "./plugin-test-helpers.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const STUDIO = "./apps/api/src/plugins/testing/apps/studio";

describe("pnpm plugin pack: storefront components", () => {
  it("compiles the module, islands, stylesheet and public files, and seals their digests", async () => {
    const packed = await packPlugin(STUDIO);
    expect(packed.storefront.map((file) => file.path).sort()).toEqual(["islands/carousel.js", "public/mark.svg", "storefront.js", "styles.css"]);
    const module = packed.storefront.find((file) => file.path === "storefront.js");
    // Self-contained and small: no imports left, no zod in it.
    expect(Buffer.from(module.bytes).toString("utf8")).not.toMatch(/\bimport\s*[{*"]/);
    expect(module.bytes.byteLength).toBeLessThan(32 * 1024);
    expect(packed.storefront.find((file) => file.path === "islands/carousel.js").bytes.byteLength).toBeLessThan(4 * 1024);
    for (const file of packed.storefront) expect(packed.code).toContain(`"${file.path}":"${file.sha256}"`);
  }, 60_000);

  it("seals nothing for an app without storefront files", () => {
    expect(sealStorefront("code\n", [])).toBe("code\n");
  });

  it("checks a declared header at pack time and accepts a campaign with no host actions", async () => {
    const plugin = makeTempPlugin();
    try {
      editSource(plugin.dir, (source) => source.replace("  storefront: {", '  storefront: {\n    skins: [{ id: "masthead", target: "header", name: "Masthead", settings: [] }],'));
      const writeHeader = (html) => writeFileSync(join(plugin.dir, "src/storefront.tsx"), `
        import { defineStorefront, raw } from "@scalius/plugin-sdk/storefront";
        export default defineStorefront({ sections: { banner: () => null }, skins: { masthead: () => raw(${JSON.stringify(html)}) } });
      `);
      writeHeader('<header id="menu"><nav id="menu"></nav></header>');
      await expect(packPlugin(plugin.dir)).rejects.toThrow('skin:masthead (header): Duplicate id "menu"');
      writeHeader('<header><scalius-island data-island="missing"></scalius-island></header>');
      await expect(packPlugin(plugin.dir)).rejects.toThrow('Island "missing" is not declared in storefront.islands');
      writeHeader('<header><a href="/">Campaign</a></header>');
      expect((await packPlugin(plugin.dir)).storefront.map((file) => file.path)).toEqual(["storefront.js"]);
    } finally {
      plugin.cleanup();
    }
  }, 60_000);
});
