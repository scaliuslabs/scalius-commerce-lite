import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { compileSqliteDdlForPostgres } from "../scripts/postgres-schema";
import { splitSchemaMigrationStatements } from "../src/schema-upgrade";

const migrationPath = resolve(
  import.meta.dirname,
  "../migrations/0053_checkout_language_authority.sql",
);
const postgresMigrationPath = resolve(
  import.meta.dirname,
  "../migrations/postgres/0053_checkout_language_authority.sql",
);

function createLegacyDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE checkout_languages (
      id text PRIMARY KEY NOT NULL,
      is_active integer DEFAULT 0 NOT NULL,
      is_default integer DEFAULT 0 NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      deleted_at integer
    );
    CREATE TABLE scalius_schema_migrations (
      version integer PRIMARY KEY NOT NULL,
      name text NOT NULL,
      source_sha256 text NOT NULL
    );
    INSERT INTO checkout_languages VALUES
      ('trashed-newest', 1, 1, 40, 400, 500),
      ('live-older', 1, 1, 10, 100, NULL),
      ('live-newer', 1, 1, 20, 200, NULL),
      ('inactive', 0, 0, 30, 300, NULL);
  `);
  return database;
}

describe("checkout language authority migration", () => {
  it("keeps one deterministic live winner and rejects a second direct writer", () => {
    const database = createLegacyDatabase();
    try {
      for (const statement of splitSchemaMigrationStatements(
        readFileSync(migrationPath, "utf8"),
      )) {
        database.exec(statement);
      }

      expect(database.prepare(`
        SELECT id FROM checkout_languages WHERE is_active = 1
      `).all()).toEqual([{ id: "live-newer" }]);
      expect(database.prepare(`
        SELECT id FROM checkout_languages WHERE is_default = 1
      `).all()).toEqual([{ id: "live-newer" }]);
      expect(() => database.exec(`
        UPDATE checkout_languages SET is_active = 1 WHERE id = 'inactive'
      `)).toThrow(/unique constraint failed/i);
      expect(() => database.exec(`
        UPDATE checkout_languages SET is_default = 1 WHERE id = 'inactive'
      `)).toThrow(/unique constraint failed/i);
    } finally {
      database.close();
    }
  });

  it("keeps the PostgreSQL sidecar equivalent to the canonical repair and indexes", () => {
    const source = splitSchemaMigrationStatements(
      readFileSync(migrationPath, "utf8"),
    );
    const postgres = splitSchemaMigrationStatements(
      readFileSync(postgresMigrationPath, "utf8"),
    );

    expect(postgres.slice(0, -1).map((statement) => statement.trim())).toEqual(
      source.slice(0, -1).map((statement) =>
        `${compileSqliteDdlForPostgres(statement).replace(/;\s*$/, "")};`
      ),
    );
  });
});
