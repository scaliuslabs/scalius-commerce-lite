import { spawn, spawnSync } from "child_process";
import { once } from "events";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runDevSh(args = [], env = {}) {
  const inherited = { ...process.env };
  // The test decides the ports; a developer's exported slot must not leak in.
  for (const name of ["SCALIUS_DEV_API_PORT", "SCALIUS_DEV_STOREFRONT_PORT", "SCALIUS_DEV_ADMIN_PORT", "SCALIUS_DEV_API_READY_URL"]) {
    delete inherited[name];
  }
  return spawnSync("bash", ["scripts/dev.sh", ...args], {
    cwd: root,
    env: {
      ...inherited,
      SCALIUS_DEV_DRY_RUN: "1",
      SCALIUS_DEV_API_READY_TIMEOUT_SECONDS: "1",
      ...env,
    },
    encoding: "utf8",
  });
}

describe("dev.sh startup planning", () => {
  it("supports an API-only startup path through the wrapper", () => {
    const result = runDevSh(["--filter=@scalius/api"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Starting local mailbox (port 8025)...");
    expect(result.stdout.indexOf("Starting local mailbox")).toBeLessThan(
      result.stdout.indexOf("Starting API worker"),
    );
    expect(result.stdout).toContain("Applying local D1 migrations...");
    expect(result.stdout).toContain("Starting API worker (port 8787)...");
    expect(result.stdout).toContain("API worker name: scalius-api-local\n");
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

  it("keeps full-stack startup ordered behind API readiness", () => {
    const result = runDevSh();

    expect(result.status).toBe(0);
    const apiIndex = result.stdout.indexOf("Starting API worker");
    const waitIndex = result.stdout.indexOf("Waiting for API readiness");
    const adminIndex = result.stdout.indexOf("Starting admin dashboard");
    const storefrontIndex = result.stdout.indexOf("Starting storefront");

    expect(apiIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeGreaterThan(apiIndex);
    expect(adminIndex).toBeGreaterThan(waitIndex);
    expect(storefrontIndex).toBeGreaterThan(adminIndex);
  });

  it("runs a parallel stack on the ports it is given, and points the local Platform settings at them", () => {
    const result = runDevSh(["--api-port", "8931", "--storefront-port=4531", "--admin-port", "4532"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Starting API worker (port 8931)...");
    expect(result.stdout).toContain("API worker name: scalius-api-local-8931");
    expect(result.stdout).toContain("Waiting for API readiness at http://localhost:8931/api/v1/setup...");
    expect(result.stdout).toContain("Starting admin dashboard (port 4532)...");
    expect(result.stdout).toContain("Starting storefront (port 4531)...");
    expect(result.stdout).toContain(
      "[dry-run] node scripts/dev-ports.mjs sync-platform (api 8931, storefront 4531, admin 4532)",
    );
    expect(result.stdout.indexOf("Applying local D1 migrations")).toBeLessThan(
      result.stdout.indexOf("Pointing local Platform settings"),
    );
    expect(result.stdout.indexOf("Pointing local Platform settings")).toBeLessThan(
      result.stdout.indexOf("Starting API worker"),
    );
    expect(result.stdout).toContain("Storefront: http://localhost:4531");
    expect(result.stdout).not.toMatch(/8787|4322|4323/);
  });

  it("takes the ports from SCALIUS_DEV_*_PORT and keeps --filter working beside the port flags", () => {
    const result = runDevSh(["--filter=@scalius/api", "--api-port", "8941"], { SCALIUS_DEV_STOREFRONT_PORT: "4541" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Starting API worker (port 8941)...");
    expect(result.stdout).toContain("(api 8941, storefront 4541, admin 4323)");
    expect(result.stdout).not.toContain("Starting storefront");
  });

  it.each([
    [["--api-port", "abc"], /API port .* must be a TCP port/],
    [["--admin-port", "70000"], /Admin port .* must be a TCP port/],
    [["--api-port", "4322"], /Local dev ports must differ/],
    [["--api-port"], /Option --api-port requires a value/],
  ])("refuses %j", (args, message) => {
    const result = runDevSh(args);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).not.toContain("Starting API worker");
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
