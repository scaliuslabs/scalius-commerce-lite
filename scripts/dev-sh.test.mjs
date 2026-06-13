import { spawnSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runDevSh(args = []) {
  return spawnSync("bash", ["scripts/dev.sh", ...args], {
    cwd: root,
    env: {
      ...process.env,
      SCALIUS_DEV_DRY_RUN: "1",
      SCALIUS_DEV_API_READY_TIMEOUT_SECONDS: "1",
      SCALIUS_DEV_STAGGER_SECONDS: "1",
    },
    encoding: "utf8",
  });
}

describe("dev.sh startup planning", () => {
  it("supports an API-only startup path through the wrapper", () => {
    const result = runDevSh(["--filter=@scalius/api"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Applying local D1 migrations...");
    expect(result.stdout).toContain("Starting API worker (port 8787)...");
    expect(result.stdout).toContain("Waiting for API readiness at http://localhost:8787/api/v1/setup...");
    expect(result.stdout).toContain("API dev server running. Ctrl+C to stop.");
    expect(result.stdout).not.toContain("Starting admin dashboard");
    expect(result.stdout).not.toContain("Starting storefront");
  });

  it("waits for API readiness before admin startup", () => {
    const result = runDevSh(["--filter=@scalius/admin-v2", "--filter=@scalius/api"]);

    expect(result.status).toBe(0);
    const apiIndex = result.stdout.indexOf("Starting API worker");
    const waitIndex = result.stdout.indexOf("Waiting for API readiness");
    const adminIndex = result.stdout.indexOf("Starting admin dashboard");

    expect(apiIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeGreaterThan(apiIndex);
    expect(adminIndex).toBeGreaterThan(waitIndex);
    expect(result.stdout).not.toContain("Starting storefront");
  });

  it("keeps full-stack startup ordered and staggers admin before storefront", () => {
    const result = runDevSh();

    expect(result.status).toBe(0);
    const apiIndex = result.stdout.indexOf("Starting API worker");
    const waitIndex = result.stdout.indexOf("Waiting for API readiness");
    const adminIndex = result.stdout.indexOf("Starting admin dashboard");
    const staggerIndex = result.stdout.indexOf("[dry-run] would wait 1s");
    const storefrontIndex = result.stdout.indexOf("Starting storefront");

    expect(apiIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeGreaterThan(apiIndex);
    expect(adminIndex).toBeGreaterThan(waitIndex);
    expect(staggerIndex).toBeGreaterThan(adminIndex);
    expect(storefrontIndex).toBeGreaterThan(staggerIndex);
  });
});
