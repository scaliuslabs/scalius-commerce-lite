import { describe, expect, it } from "vitest";

import {
  createDatabaseMigrationFreezeResponse,
  isDatabaseMigrationFrozen,
} from "./database-migration-freeze";

describe("database migration freeze", () => {
  it("accepts only explicit active values", () => {
    expect(isDatabaseMigrationFrozen({ DATABASE_MIGRATION_FREEZE: "1" })).toBe(true);
    expect(isDatabaseMigrationFrozen({ DATABASE_MIGRATION_FREEZE: " TRUE " })).toBe(true);
    expect(isDatabaseMigrationFrozen({ DATABASE_MIGRATION_FREEZE: "on" })).toBe(true);
    expect(isDatabaseMigrationFrozen({ DATABASE_MIGRATION_FREEZE: "0" })).toBe(false);
    expect(isDatabaseMigrationFrozen({})).toBe(false);
  });

  it("fails closed with a bounded retry contract", async () => {
    const response = createDatabaseMigrationFreezeResponse(
      new Request("https://api.example.test/api/v1/orders", { method: "POST" }),
      { DATABASE_MIGRATION_FREEZE: "1" },
    );

    expect(response?.status).toBe(503);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("Retry-After")).toBe("60");
    expect(await response?.json()).toEqual({
      success: false,
      error: "Commerce data migration is in progress. Please retry shortly.",
      code: "DATABASE_MIGRATION_IN_PROGRESS",
    });
  });

  it("allows only API health and readiness reads when requested", () => {
    const env = { DATABASE_MIGRATION_FREEZE: "true" };

    expect(createDatabaseMigrationFreezeResponse(
      new Request("https://api.example.test/api/v1/health"),
      env,
      { allowApiProbes: true },
    )).toBeNull();
    expect(createDatabaseMigrationFreezeResponse(
      new Request("https://api.example.test/api/v1/readyz", { method: "HEAD" }),
      env,
      { allowApiProbes: true },
    )).toBeNull();
    expect(createDatabaseMigrationFreezeResponse(
      new Request("https://api.example.test/api/v1/products"),
      env,
      { allowApiProbes: true },
    )?.status).toBe(503);
    expect(createDatabaseMigrationFreezeResponse(
      new Request("https://api.example.test/api/v1/health", { method: "POST" }),
      env,
      { allowApiProbes: true },
    )?.status).toBe(503);
  });
});
