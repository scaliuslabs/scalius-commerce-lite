/**
 * A shared zod schema can be created before the OpenAPI extension runs: the
 * Worker loads route families lazily, in whatever order requests arrive, and
 * zod 4 gives `.openapi()` only to schemas created after the extension. The
 * live symptom was "….openapi is not a function" (500) on whichever admin
 * route first loaded the theme schemas in a fresh isolate. Every API schema
 * module must load in that order, and no route may call `.openapi()` directly
 * on a schema imported from `@scalius/shared` (use `namedSharedSchema`).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("../../../../", import.meta.url);

describe("shared schemas created before the OpenAPI extension", () => {
  it("lets every API schema module load after the shared schemas exist", async () => {
    const shared = await import("@scalius/shared/storefront-theme");
    expect(typeof (shared.storeShapeSchema as { openapi?: unknown }).openapi).toBe("undefined");
    await expect(import("./storefront-theme")).resolves.toBeDefined();
  });

  it("never calls .openapi() directly on a schema imported from @scalius/shared", () => {
    const files = execFileSync("git", ["ls-files", "apps/api/src/*.ts"], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .filter((file) => file && !file.includes(".test.") && !file.endsWith(".gen.ts"));
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(new URL(file, repoRoot), "utf8");
      for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@scalius\/shared\/[^"]+"/g)) {
        for (const part of match[1]!.split(",")) {
          const name = part.replace(/\btype\b/, "").split(" as ").pop()!.trim();
          if (name && new RegExp(`\\b${name}\\s*\\.openapi\\(`).test(source)) offenders.push(`${file}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
