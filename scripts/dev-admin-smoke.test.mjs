import { describe, expect, it } from "vitest";
import {
  buildBusinessSettingsSmokePayload,
  buildCookieHeader,
  getAdminSmokeConfig,
  normalizeSmokeOrigin,
  splitCombinedSetCookieHeader,
} from "./dev-admin-smoke.mjs";

describe("local admin settings smoke CLI", () => {
  it("rejects non-local mutation targets", () => {
    expect(() => getAdminSmokeConfig(["--api", "https://api.scalius.com"], {})).toThrow(
      /known production/,
    );
    expect(() => getAdminSmokeConfig(["--admin", "https://dashboard.scalius.com"], {})).toThrow(
      /known production/,
    );
    expect(() => getAdminSmokeConfig(["--api", "https://staging.example.com"], {})).toThrow(
      /non-local/,
    );
  });

  it("accepts loopback targets and parses local smoke options", () => {
    const config = getAdminSmokeConfig([
      "smoke",
      "--api",
      "http://127.0.0.1:8787/",
      "--admin",
      "http://localhost:4323/",
      "--email",
      "admin@example.test",
      "--password",
      "ExamplePassword123!",
      "--name",
      "Example Admin",
      "--state",
      "tmp/admin-smoke-state",
      "--no-start",
      "--skip-setup",
      "--reset-admin",
    ], {});

    expect(config).toMatchObject({
      command: "smoke",
      apiBaseUrl: "http://127.0.0.1:8787",
      adminBaseUrl: "http://localhost:4323",
      email: "admin@example.test",
      password: "ExamplePassword123!",
      name: "Example Admin",
      noStart: true,
      skipSetup: true,
      resetAdmin: true,
    });
    expect(config.wranglerState).toMatch(/tmp\/admin-smoke-state$/);
  });

  it("rejects path-bearing base URLs before any worker work", () => {
    expect(() => normalizeSmokeOrigin("http://localhost:4323/admin", "admin URL")).toThrow(
      /without a path/,
    );
    expect(() => normalizeSmokeOrigin("http://localhost:8787?x=1", "API URL")).toThrow(
      /without a path/,
    );
  });

  it("rejects missing value-style flags and short passwords", () => {
    expect(() => getAdminSmokeConfig(["--admin"], {})).toThrow(
      /Option --admin requires a value/,
    );
    expect(() => getAdminSmokeConfig(["--password", "short"], {})).toThrow(
      /at least 12 characters/,
    );
  });

  it("rejects unknown positional commands", () => {
    expect(() => getAdminSmokeConfig(["bogus"], {})).toThrow(/Unknown command: bogus/);
  });

  it("builds a tiny no-op business settings save payload", () => {
    const payload = buildBusinessSettingsSmokePayload({
      companyName: "Example",
      legalName: "Example LLC",
      invoicePrefix: "INV",
      invoiceFooterText: "Thank you",
    });

    expect(payload).toEqual({ invoicePrefix: "INV" });
    expect(payload).not.toHaveProperty("companyName");
    expect(payload).not.toHaveProperty("invoiceFooterText");
  });

  it("requires invoicePrefix in the business settings response", () => {
    expect(() => buildBusinessSettingsSmokePayload({ companyName: "Example" })).toThrow(
      /invoicePrefix/,
    );
  });

  it("builds a Cookie header from multiple Set-Cookie values", () => {
    const setCookie = splitCombinedSetCookieHeader(
      "better-auth.session_token=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly, better-auth.session_data=def; Path=/; HttpOnly",
    );

    expect(setCookie).toEqual([
      "better-auth.session_token=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly",
      "better-auth.session_data=def; Path=/; HttpOnly",
    ]);
    expect(buildCookieHeader(setCookie)).toBe(
      "better-auth.session_token=abc; better-auth.session_data=def",
    );
  });
});
