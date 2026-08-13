import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const apiFunctionsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "api-functions",
);

const serverOnlyModules = new Set([
  "auth-management.ts",
  "cache.ts",
  "firebase.ts",
]);

describe("admin API transport boundary", () => {
  it("keeps ordinary admin API modules off TanStack server-function RPC", async () => {
    const filenames = (await readdir(apiFunctionsDirectory)).filter(
      (filename) => filename.endsWith(".ts") && !filename.endsWith(".test.ts"),
    );

    for (const filename of filenames) {
      const source = await readFile(join(apiFunctionsDirectory, filename), "utf8");
      if (serverOnlyModules.has(filename)) {
        expect(source, filename).toContain(
          'from "@tanstack/react-start"',
        );
        continue;
      }

      expect(source, filename).not.toContain(
        'from "@tanstack/react-start"',
      );
      expect(source, filename).not.toContain('from "../api.server"');
      if (source.includes("createServerFn(")) {
        expect(source, filename).toContain(
          'from "../admin-api-function"',
        );
      }
    }
  });
});
