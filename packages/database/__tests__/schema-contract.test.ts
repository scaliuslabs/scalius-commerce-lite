import { describe, expect, it } from "vitest";

import {
  assertDatabaseSchemaCompatible,
  CURRENT_DATABASE_SCHEMA,
  CURRENT_DATABASE_SCHEMA_MIGRATIONS,
  readDatabaseSchemaState,
} from "../src/schema-contract";
import type { Database } from "../src/types";

function databaseReturning(rows: readonly Record<string, unknown>[]): Database {
  return {
    select: () => ({
      from: () => ({
        orderBy: () => ({
          all: async () => rows,
        }),
      }),
    }),
  } as unknown as Database;
}

describe("database schema contract", () => {
  it("accepts only the exact release migration identity", () => {
    expect(assertDatabaseSchemaCompatible(CURRENT_DATABASE_SCHEMA_MIGRATIONS))
      .toEqual(CURRENT_DATABASE_SCHEMA);
  });

  it.each([
    [undefined, /authority is missing/i],
    [[], /authority is missing/i],
    [[{
      version: 49,
      name: "0049_checkout_side_effect_authority_fence",
      sourceSha256: "a".repeat(64),
    }], /has 1 row/i],
    [[...CURRENT_DATABASE_SCHEMA_MIGRATIONS, {
      version: 59,
      name: "0059_future",
      sourceSha256: "b".repeat(64),
    }], /has 10 row/i],
    [[{
      ...CURRENT_DATABASE_SCHEMA_MIGRATIONS[0],
      name: "0050_wrong",
    }, ...CURRENT_DATABASE_SCHEMA_MIGRATIONS.slice(1)], /diverges/i],
    [[{
      ...CURRENT_DATABASE_SCHEMA_MIGRATIONS[0],
      sourceSha256: "c".repeat(64),
    }, ...CURRENT_DATABASE_SCHEMA_MIGRATIONS.slice(1)], /diverges/i],
    [[{
      version: "invalid",
      name: "0050_schema_release_contract",
      sourceSha256: "invalid",
    }], /authority is invalid/i],
  ])("rejects missing, stale, extra, changed, or malformed authority %#", (rows, expected) => {
    expect(() => assertDatabaseSchemaCompatible(rows)).toThrow(expected);
  });

  it("applies the same exact ledger contract through provider-neutral database clients", async () => {
    await expect(readDatabaseSchemaState(
      databaseReturning(CURRENT_DATABASE_SCHEMA_MIGRATIONS),
    )).resolves.toEqual(CURRENT_DATABASE_SCHEMA);

    await expect(readDatabaseSchemaState(databaseReturning([
      {
        ...CURRENT_DATABASE_SCHEMA_MIGRATIONS[0],
        sourceSha256: "d".repeat(64),
      },
      ...CURRENT_DATABASE_SCHEMA_MIGRATIONS.slice(1),
    ]))).rejects.toThrow(/diverges at version 50/i);
  });
});
