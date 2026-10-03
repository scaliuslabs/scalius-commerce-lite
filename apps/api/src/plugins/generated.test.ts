// The generated plugin modules are fresh: the sandbox wrapper is exactly what
// `pnpm plugin build` compiles from runtime/sandbox-entry.ts and the SDK
// runtime, and bundled.gen.ts plus scalius.plugins.json match what packing
// each bundled plugin produces today.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_GEN,
  SANDBOX_RUNTIME_GEN,
  buildSandboxRuntime,
  packPlugin,
  readLockfile,
  renderBundledGen,
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

  it("ships every first-party app in Bangla too", async () => {
    for (const plugin of readLockfile().plugins.filter((entry) => entry.source.startsWith("plugins/"))) {
      const { manifest } = await packPlugin(plugin.source);
      expect(manifest, plugin.id).toMatchObject({ translations: { bn: { name: expect.any(String), description: expect.any(String) } } });
    }
  });
});
