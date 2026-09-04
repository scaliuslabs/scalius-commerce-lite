import { spawn, spawnSync } from "child_process";
import { once } from "events";
import { readFileSync } from "fs";
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
  it("protects cleanup from repeated lifecycle signals", () => {
    expect(readFileSync(resolve(root, "scripts/dev.sh"), "utf8")).toContain(
      "cleanup() {\n  local status=$?\n  trap - EXIT\n  trap '' SIGINT SIGTERM",
    );
  });

  it("supports an API-only startup path through the wrapper", () => {
    const result = runDevSh(["--filter=@scalius/api"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Starting local mailbox (port 8025)...");
    expect(result.stdout.indexOf("Starting local mailbox")).toBeLessThan(
      result.stdout.indexOf("Starting API worker"),
    );
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

  it("reports an occupied app port without terminating its owner", async () => {
    const port = "8787";
    const existingPid = spawnSync("lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    }).stdout.trim().split(/\s+/)[0];
    const listener = existingPid ? undefined : spawn(process.execPath, [
      "-e",
      `require("net").createServer().listen(${port}, "127.0.0.1", function () { console.log(this.address().port) })`,
    ]);

    try {
      if (listener) await once(listener.stdout, "data");
      const ownerPid = existingPid || String(listener.pid);
      const result = spawnSync("bash", ["scripts/dev.sh"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Port ${port} is already in use by PID ${ownerPid}`);
      expect(() => process.kill(Number(ownerPid), 0)).not.toThrow();
    } finally {
      listener?.kill("SIGTERM");
    }
  });
});
