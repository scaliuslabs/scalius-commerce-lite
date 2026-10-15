import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devPlugin, previewPlugin } from "./plugin-dev.mjs";
import { makeTempPlugin } from "./plugin-test-helpers.mjs";

describe("plugin fixture preview", () => {
  it("packs a component app and writes safe fixture HTML beside its assets", async () => {
    const app = makeTempPlugin();
    try {
      const result = await previewPlugin(app.dir);
      expect(result).toMatchObject({ id: "acme.tally", views: 1, output: join(app.dir, "dist/preview.html") });
      const html = readFileSync(result.output, "utf8");
      expect(html).toContain("section:banner");
      expect(html).toContain("Hello from Tally");
      expect(html).toContain("form-action 'none'");
      expect(html).not.toContain("<script");
      expect(readFileSync(join(app.dir, "dist/manifest.json"), "utf8")).toContain('"acme.tally"');
    } finally {
      app.cleanup();
    }
  });

  it("rebuilds the fixture after a source edit without watching its own output", async () => {
    const app = makeTempPlugin();
    let watcher;
    try {
      watcher = await devPlugin(app.dir);
      const source = join(app.dir, "src/index.ts");
      writeFileSync(source, readFileSync(source, "utf8").replace("Hello from Tally", "Changed by the author"));
      await expect.poll(() => readFileSync(join(app.dir, "dist/preview.html"), "utf8"), { timeout: 5000 }).toContain("Changed by the author");
    } finally {
      watcher?.close();
      app.cleanup();
    }
  });
});
