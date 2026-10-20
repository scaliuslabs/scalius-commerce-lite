import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devPlugin, previewPlugin, readPreviewFixture } from "./plugin-dev.mjs";
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

  it("says when a view renders nothing, and takes the values it reads from --fixture (DX-5)", async () => {
    const app = makeTempPlugin();
    try {
      const empty = await previewPlugin(app.dir, undefined, { fixture: { settings: { "section:banner": { heading: "", text: "" } } } });
      expect(empty.empty).toEqual(["section:banner"]);
      expect(readFileSync(empty.output, "utf8")).toContain("Rendered nothing with these fixtures.");

      const fixturePath = join(app.dir, "fixture.json");
      writeFileSync(fixturePath, JSON.stringify({ settings: { "section:banner": { heading: "From the fixture" } } }));
      const filled = await previewPlugin(app.dir, undefined, { fixture: readPreviewFixture(fixturePath) });
      expect(filled.empty).toEqual([]);
      expect(readFileSync(filled.output, "utf8")).toContain("From the fixture");

      writeFileSync(fixturePath, JSON.stringify({ setings: {} }));
      expect(() => readPreviewFixture(fixturePath)).toThrow('unknown key "setings"');
      await expect(previewPlugin(app.dir, undefined, { fixture: { settings: { "block:nope": {} } } })).rejects.toThrow("not a view of this app");
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
