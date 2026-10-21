import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { STOREFRONT_DEV_CONFIG, processEnvHasSecrets, writeDevWranglerConfig } from "./dev-secrets.mjs";

describe("dev secrets", () => {
  it("accepts process-env secrets only when every installed secret of the Worker is set", () => {
    expect(processEnvHasSecrets("storefront", { SCALIUS_SECRET: "s" })).toBe(true);
    expect(processEnvHasSecrets("api", { SCALIUS_SECRET: "s" })).toBe(false);
    expect(processEnvHasSecrets("api", { SCALIUS_SECRET: "s", CREDENTIAL_ENCRYPTION_KEY: " " })).toBe(false);
    expect(processEnvHasSecrets("api", { SCALIUS_SECRET: "s", CREDENTIAL_ENCRYPTION_KEY: "k" })).toBe(true);
  });

  it("writes a dev copy of a Wrangler config beside it that declares only the required secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "scalius-dev-secrets-"));
    try {
      const source = join(dir, "wrangler.jsonc");
      writeFileSync(source, '{\n  // comment\n  "name": "w", "main": "./src/worker.ts"\n}\n');
      const out = writeDevWranglerConfig(pathToFileURL(source), ["SCALIUS_SECRET"]);
      expect(out).toBe(join(dir, STOREFRONT_DEV_CONFIG));
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
        name: "w",
        main: "./src/worker.ts",
        secrets: { required: ["SCALIUS_SECRET"] },
      });
      // The plugin sandbox gives the dev storefront the Worker Loader that draws uploaded apps' parts.
      writeDevWranglerConfig(pathToFileURL(source), ["SCALIUS_SECRET"], { workerLoader: true });
      expect(JSON.parse(readFileSync(out, "utf8")).worker_loaders).toEqual([{ binding: "LOADER" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebinds a service binding to this stack's local worker name", () => {
    const dir = mkdtempSync(join(tmpdir(), "scalius-dev-secrets-"));
    try {
      const source = join(dir, "wrangler.jsonc");
      writeFileSync(source, JSON.stringify({ name: "s", services: [{ binding: "BACKEND_API", service: "scalius-api" }, { binding: "OTHER", service: "x" }] }));
      const out = writeDevWranglerConfig(pathToFileURL(source), ["SCALIUS_SECRET"], { services: { BACKEND_API: "scalius-api-local-8931" } });
      expect(JSON.parse(readFileSync(out, "utf8")).services).toEqual([
        { binding: "BACKEND_API", service: "scalius-api-local-8931" },
        { binding: "OTHER", service: "x" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
