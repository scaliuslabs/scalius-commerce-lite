import { describe, expect, it } from "vitest";
import {
  formatTextReport,
  findRetiredMigrationEntries,
  findPlatformOriginDrift,
  getDoctorConfig,
  getExitCode,
  getServiceIdsForProfile,
  summarizeChecks,
} from "./dev-doctor.mjs";

describe("dev doctor helpers", () => {
  it("rejects retired or reused Wrangler migration filenames", () => {
    expect(findRetiredMigrationEntries(
      [
        "0054_cache_invalidation_delivery.sql",
        "0055_glossy_blue_blade.sql",
        "0060_lumpy_switch.sql",
      ],
      [
        "0054_cache_invalidation_delivery.sql",
        "0055_cache_invalidation_postgres_bigint.sql",
      ],
    )).toEqual([
      {
        applied: "0055_glossy_blue_blade.sql",
        current: "0055_cache_invalidation_postgres_bigint.sql",
      },
      { applied: "0060_lumpy_switch.sql", current: null },
    ]);
  });

  it("accepts an applied Wrangler history owned by the current repository", () => {
    const names = [
      "0054_cache_invalidation_delivery.sql",
      "0055_cache_invalidation_postgres_bigint.sql",
    ];
    expect(findRetiredMigrationEntries(names, names)).toEqual([]);
  });

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
    expect(getServiceIdsForProfile("all")).toEqual(["mailbox", "api", "admin", "storefront"]);
  });

  it("maps partial service profiles to their expected services", () => {
    expect(getServiceIdsForProfile("api")).toEqual(["mailbox", "api"]);
    expect(getServiceIdsForProfile("admin")).toEqual(["mailbox", "api", "admin"]);
    expect(getServiceIdsForProfile("storefront")).toEqual(["mailbox", "api", "storefront"]);
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
          title: "Installed local secrets",
          detail: "SCALIUS_SECRET differs between local .dev.vars files",
          action: "Run pnpm dev:setup --force",
        },
      ],
    });

    expect(report).toContain("[fail] Installed local secrets");
    expect(report).toContain("SCALIUS_SECRET differs");
    expect(report).not.toContain("super-secret-value");
  });

  it("keeps the LOCAL_API_BASE_URL override for the running-API probe", () => {
    expect(getDoctorConfig([], { LOCAL_API_BASE_URL: "http://127.0.0.1:9999/" }).apiBaseUrl)
      .toBe("http://127.0.0.1:9999");
    expect(getDoctorConfig([], {}).apiBaseUrl).toBe("http://localhost:8787");
  });

  it("checks the stack on the ports scripts/dev.sh was given", () => {
    const fromEnv = getDoctorConfig([], {
      SCALIUS_DEV_API_PORT: "8931",
      SCALIUS_DEV_STOREFRONT_PORT: "4531",
      SCALIUS_DEV_ADMIN_PORT: "4532",
    });
    expect(fromEnv).toMatchObject({
      apiBaseUrl: "http://localhost:8931",
      storefrontBaseUrl: "http://localhost:4531",
      adminBaseUrl: "http://localhost:4532",
    });
    const fromFlags = getDoctorConfig(["--api-port", "8941", "--admin-port=4542"], { SCALIUS_DEV_API_PORT: "8931" });
    expect(fromFlags).toMatchObject({
      apiBaseUrl: "http://localhost:8941",
      storefrontBaseUrl: "http://localhost:4322",
      adminBaseUrl: "http://localhost:4542",
    });
    expect(() => getDoctorConfig(["--api-port", "nope"], {})).toThrow(/must be a TCP port/);
  });

  it("flags local Platform origins that point at another stack, and ignores real URLs", () => {
    const expected = {
      apiUrl: "http://localhost:8931",
      storefrontUrl: "http://localhost:4531",
      dashboardUrl: "http://localhost:4532",
      mediaUrl: "http://localhost:8931/api/v1/media",
    };
    expect(findPlatformOriginDrift(expected, expected)).toEqual([]);
    expect(findPlatformOriginDrift({
      ...expected,
      apiUrl: "http://localhost:8787",
      storefrontUrl: "https://shop.tunnel.example",
      dashboardUrl: "",
    }, expected).map(({ field }) => field)).toEqual(["apiUrl", "dashboardUrl"]);
  });
});
