import { describe, expect, it } from "vitest";
import {
  getDatabaseProviderCapabilities,
  resolveDatabaseConfiguration,
} from "../src/provider";

describe("database provider resolution", () => {
  const d1 = {} as D1Database;

  it("keeps D1 as the zero-configuration default", () => {
    expect(resolveDatabaseConfiguration({ DB: d1 })).toEqual({
      provider: "d1",
      binding: d1,
    });
  });

  it("declares provider capabilities used by migrations and search", () => {
    expect(getDatabaseProviderCapabilities("d1")).toEqual({
      concurrentWrites: false,
      fts5: true,
      recursiveCte: true,
      sqliteDialect: true,
      withoutRowid: true,
    });
    expect(getDatabaseProviderCapabilities("turso")).toEqual({
      concurrentWrites: true,
      fts5: false,
      recursiveCte: false,
      sqliteDialect: true,
      withoutRowid: false,
    });
  });

  it("selects Turso when both deployment secrets are installed", () => {
    expect(resolveDatabaseConfiguration({
      DB: d1,
      TURSO_DATABASE_URL: "libsql://merchant.turso.io",
      TURSO_AUTH_TOKEN: "token",
    })).toEqual({
      provider: "turso",
      url: "libsql://merchant.turso.io",
      authToken: "token",
    });
  });

  it("allows an explicit D1 rollback while Turso secrets remain installed", () => {
    expect(resolveDatabaseConfiguration({
      DB: d1,
      DATABASE_PROVIDER: "d1",
      TURSO_DATABASE_URL: "libsql://merchant.turso.io",
      TURSO_AUTH_TOKEN: "token",
    })).toEqual({ provider: "d1", binding: d1 });
  });

  it("fails closed for partial or unsupported configuration", () => {
    expect(() => resolveDatabaseConfiguration({
      TURSO_DATABASE_URL: "libsql://merchant.turso.io",
    })).toThrow(/TURSO_AUTH_TOKEN/);
    expect(() => resolveDatabaseConfiguration({
      TURSO_AUTH_TOKEN: "token",
    })).toThrow(/TURSO_DATABASE_URL/);
    expect(() => resolveDatabaseConfiguration({
      DATABASE_PROVIDER: "postgres",
    })).toThrow(/Unsupported DATABASE_PROVIDER/);
  });

  it("rejects credential-bearing endpoints without exposing the token", () => {
    const secret = "must-not-appear";
    let message = "";
    try {
      resolveDatabaseConfiguration({
        DATABASE_PROVIDER: "turso",
        TURSO_DATABASE_URL: "https://user:password@merchant.turso.io",
        TURSO_AUTH_TOKEN: secret,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/credential-free/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain("password");
  });
});
