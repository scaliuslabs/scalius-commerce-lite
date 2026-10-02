import { describe, expect, it } from "vitest";
import { judgeApiBundle, measureWorkerOutput, API_BUNDLE_BUDGET_BYTES, WORKER_SIZE_LIMIT_BYTES } from "./check-api-bundle.mjs";
import { isPathSource, renderBundledGen, renderLockfile } from "./plugin-build.mjs";
import { pluginSandboxEnabled, scaffoldFiles, withPluginSandbox } from "./plugins.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("pnpm plugin", () => {
  it("adds the Worker Loader binding only to a generated config", () => {
    const config = withPluginSandbox(`{
      // comment
      "name": "scalius-api",
      "main": "./src/worker.ts",
    }`);
    expect(config).toEqual({ name: "scalius-api", main: "./src/worker.ts", worker_loaders: [{ binding: "LOADER" }] });
    expect(withPluginSandbox(JSON.stringify(config)).worker_loaders).toEqual([{ binding: "LOADER" }]);
  });

  it("turns the sandbox on from the lockfile, the flag or the environment only", () => {
    const off = { version: 1, sandbox: false, plugins: [] };
    expect(pluginSandboxEnabled(off, {}, [])).toBe(false);
    expect(pluginSandboxEnabled(off, {}, ["--plugin-sandbox"])).toBe(true);
    expect(pluginSandboxEnabled(off, { SCALIUS_PLUGIN_SANDBOX: "1" }, [])).toBe(true);
    expect(pluginSandboxEnabled({ ...off, sandbox: true }, {}, [])).toBe(true);
  });

  it("renders the lockfile and the bundled map deterministically", () => {
    const lockfile = {
      version: 1,
      sandbox: false,
      plugins: [
        { id: "zeta.b", version: "1.0.0", source: "plugins/b", sha256: "b".repeat(64) },
        { id: "acme.a", version: "2.0.0", source: "@acme/scalius-a", sha256: "a".repeat(64) },
      ],
    };
    expect(JSON.parse(renderLockfile(lockfile)).plugins.map((plugin) => plugin.id)).toEqual(["acme.a", "zeta.b"]);
    const generated = renderBundledGen(lockfile, (plugin) => (isPathSource(plugin.source) ? `../../../../${plugin.source}/src/index` : plugin.source));
    expect(generated).toContain('"acme.a": {\n    version: "2.0.0"');
    expect(generated).toContain('load: () => import("@acme/scalius-a")');
    expect(generated).toContain('load: () => import("../../../../plugins/b/src/index")');
    expect(generated.indexOf("acme.a")).toBeLessThan(generated.indexOf("zeta.b"));
  });

  it("scaffolds a plugin package with a manifest and matching handlers", () => {
    const files = scaffoldFiles("acme.loyalty", "loyalty");
    expect(Object.keys(files).sort()).toEqual(["package.json", "src/index.ts", "tsconfig.json"]);
    expect(JSON.parse(files["package.json"]).dependencies).toEqual({ "@scalius/plugin-sdk": "workspace:*" });
    expect(files["src/index.ts"]).toContain('id: "acme.loyalty"');
    expect(files["src/index.ts"]).toContain('"order.created": async');
  });
});

describe("API bundle size gate", () => {
  it("measures uploaded modules only and keeps a 10% margin under the documented limit (64 MiB uncompressed, both plans)", () => {
    expect(WORKER_SIZE_LIMIT_BYTES).toBe(64 * 1024 * 1024);
    expect(API_BUNDLE_BUDGET_BYTES).toBe(Math.floor(WORKER_SIZE_LIMIT_BYTES * 0.9));
    expect(judgeApiBundle(API_BUNDLE_BUDGET_BYTES)).toEqual({ ok: true, headroom: 0 });
    expect(judgeApiBundle(API_BUNDLE_BUDGET_BYTES + 1).ok).toBe(false);
    const directory = mkdtempSync(join(tmpdir(), "scalius-bundle-gate-"));
    try {
      writeFileSync(join(directory, "worker.js"), "export default {};".repeat(100));
      writeFileSync(join(directory, "worker.js.map"), "x".repeat(10_000));
      writeFileSync(join(directory, "README.md"), "notes");
      const measured = measureWorkerOutput(directory);
      expect(measured.files).toEqual(["worker.js"]);
      expect(measured.raw).toBe(1800);
      expect(measured.gzip).toBeGreaterThan(0);
      expect(measured.gzip).toBeLessThan(measured.raw);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
