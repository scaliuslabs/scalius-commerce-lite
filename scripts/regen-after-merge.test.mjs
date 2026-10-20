import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { generatedFiles } from "./regen-after-merge.mjs";

const root = resolve(import.meta.dirname, "..");

describe("generated-file merge driver", () => {
  it("covers every tracked generated file and nothing hand-sealed", () => {
    const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    const covered = new Set(generatedFiles());
    const generated = tracked.filter((file) => /\.gen\.(ts|txt)$|\/src\/generated\/|^packages\/api-client\/openapi\.json$/.test(file));
    expect(generated.filter((file) => !covered.has(file))).toEqual([]);
    for (const sealed of [
      "apps/api/src/openapi/stable-operations.snapshot.json",
      "packages/shared/src/plugins/abi.manifest.snapshot.json",
      "packages/shared/src/plugins/abi.protocol.snapshot.json",
      "scalius.plugins.json",
    ]) {
      expect(covered.has(sealed)).toBe(false);
    }
  });
});
