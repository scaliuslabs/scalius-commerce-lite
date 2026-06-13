import { describe, expect, it } from "vitest";
import {
  formatTextReport,
  getDoctorConfig,
  getExitCode,
  getServiceIdsForProfile,
  summarizeChecks,
} from "./dev-doctor.mjs";

describe("dev doctor helpers", () => {
  it("summarizes check statuses", () => {
    expect(summarizeChecks([
      { status: "pass" },
      { status: "warn" },
      { status: "fail" },
      { status: "skip" },
      { status: "pass" },
    ])).toEqual({ pass: 2, warn: 1, fail: 1, skip: 1 });
  });

  it("exits non-zero on failures and optionally warnings", () => {
    expect(getExitCode([{ status: "warn" }], { strict: false })).toBe(0);
    expect(getExitCode([{ status: "warn" }], { strict: true })).toBe(1);
    expect(getExitCode([{ status: "fail" }], { strict: false })).toBe(1);
  });

  it("parses doctor config without mutating URLs", () => {
    const config = getDoctorConfig([
      "--json",
      "--require-running",
      "--profile",
      "admin",
      "--api",
      "http://localhost:9876/",
      "--state",
      "tmp/state",
    ], {});

    expect(config.json).toBe(true);
    expect(config.requireRunning).toBe(true);
    expect(config.serviceProfile).toBe("admin");
    expect(config.apiBaseUrl).toBe("http://localhost:9876");
    expect(config.wranglerState).toMatch(/\/tmp\/state$/);
  });

  it("defaults to the full service profile", () => {
    expect(getDoctorConfig([], {}).serviceProfile).toBe("all");
    expect(getServiceIdsForProfile("all")).toEqual(["api", "admin", "storefront"]);
  });

  it("maps partial service profiles to their expected services", () => {
    expect(getServiceIdsForProfile("api")).toEqual(["api"]);
    expect(getServiceIdsForProfile("admin")).toEqual(["api", "admin"]);
    expect(getServiceIdsForProfile("storefront")).toEqual(["api", "storefront"]);
  });

  it("rejects unknown service profiles", () => {
    expect(() => getDoctorConfig(["--profile", "checkout"], {})).toThrow(/Unknown --profile/);
  });

  it("supports short help", () => {
    expect(getDoctorConfig(["-h"], {}).help).toBe(true);
  });

  it("rejects missing values for value-style flags", () => {
    expect(() => getDoctorConfig(["--state"], {})).toThrow(/requires a value/);
  });

  it("formats reports without leaking secret-like details", () => {
    const report = formatTextReport({
      root: "/repo",
      summary: { pass: 0, warn: 0, fail: 1, skip: 0 },
      checks: [
        {
          status: "fail",
          title: "Shared local secrets",
          detail: "JWT_SECRET differs between local .dev.vars files",
          action: "Run pnpm dev:setup --force",
        },
      ],
    });

    expect(report).toContain("[fail] Shared local secrets");
    expect(report).toContain("JWT_SECRET differs");
    expect(report).not.toContain("super-secret-value");
  });
});
