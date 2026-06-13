import { spawnSync } from "child_process";
import { describe, expect, it } from "vitest";

const closedLocalApi = "http://127.0.0.1:9";

function runAdminCli(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/dev-admin.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    timeout: 5000,
  });
}

describe("local admin CLI", () => {
  it("does not validate password for status checks", () => {
    const result = runAdminCli(["status", "--no-start", "--api", closedLocalApi], {
      LOCAL_ADMIN_PASSWORD: "short",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("API is not running");
    expect(result.stderr).not.toContain("password must be at least");
  });

  it("still validates password before create/reset work", () => {
    const result = runAdminCli(["create", "--no-start", "--api", closedLocalApi], {
      LOCAL_ADMIN_PASSWORD: "short",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Local admin password must be at least 12 characters");
    expect(result.stderr).not.toContain("ModuleJob.run");
  });

  it("rejects valueless password flags before API work", () => {
    const result = runAdminCli([
      "create",
      "--no-start",
      "--api",
      closedLocalApi,
      "--password",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Option --password requires a value");
    expect(result.stderr).not.toContain("API is not running");
  });

  it("checks API reachability before resetting auth tables", () => {
    const result = runAdminCli([
      "reset",
      "--skip-migrations",
      "--no-start",
      "--api",
      closedLocalApi,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("API is not running");
    expect(result.stdout).not.toContain("Resetting local auth tables");
  });

  it("rejects unknown positional commands", () => {
    const result = runAdminCli(["bogus"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: bogus");
  });
});
