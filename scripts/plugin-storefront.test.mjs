import { describe, expect, it } from "vitest";
import { packPlugin, sealStorefront } from "./plugin-build.mjs";

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
});
