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
    expect(getDatabaseProviderCapabilities("postgres")).toEqual({
      concurrentWrites: true,
      fts5: false,
      recursiveCte: true,
      sqliteDialect: false,
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
      writeBatchMode: "immediate",
    });
  });

  it("activates concurrent batches for a new TursoDB URL", () => {
    expect(resolveDatabaseConfiguration({
      TURSO_DATABASE_URL: "turso://merchant.turso.io",
      TURSO_AUTH_TOKEN: "token",
    })).toEqual({
      provider: "turso",
      url: "turso://merchant.turso.io",
      authToken: "token",
      writeBatchMode: "concurrent",
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

  it("selects PostgreSQL from one connection-string secret", () => {
    const connectionString = "postgresql://user:secret@example.neon.tech/merchant?sslmode=require";
    expect(resolveDatabaseConfiguration({
      DB: d1,
      POSTGRES_DATABASE_URL: connectionString,
    })).toEqual({ provider: "postgres", connectionString });
    expect(resolveDatabaseConfiguration({
      DATABASE_PROVIDER: "postgres",
      POSTGRES_DATABASE_URL: connectionString,
    })).toEqual({ provider: "postgres", connectionString });
  });

  it("fails closed when automatic provider selection is ambiguous", () => {
    expect(() => resolveDatabaseConfiguration({
      TURSO_DATABASE_URL: "libsql://merchant.turso.io",
      TURSO_AUTH_TOKEN: "token",
      POSTGRES_DATABASE_URL: "postgresql://user:secret@example.neon.tech/merchant",
    })).toThrow(/ambiguous/i);
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
    })).toThrow(/POSTGRES_DATABASE_URL/);
    expect(() => resolveDatabaseConfiguration({
      POSTGRES_DATABASE_URL: "https://example.com/merchant",
    })).toThrow(/postgres:\/\//);
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
