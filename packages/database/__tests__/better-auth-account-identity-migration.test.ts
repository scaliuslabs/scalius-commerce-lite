import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { splitSchemaMigrationStatements } from "../src/schema-upgrade";

const migration = splitSchemaMigrationStatements(readFileSync(resolve(
  import.meta.dirname,
  "../migrations/0060_better_auth_account_identity.sql",
), "utf8"));

function legacyDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "user" ("id" text PRIMARY KEY NOT NULL);
    CREATE TABLE "account" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "account_id" text NOT NULL,
      "provider_id" text NOT NULL,
      "access_token" text,
      "refresh_token" text,
      "access_token_expires_at" integer,
      "refresh_token_expires_at" integer,
      "scope" text,
      "password" text,
      "id_token" text,
      "created_at" integer NOT NULL,
      "updated_at" integer NOT NULL
    );
    CREATE INDEX "account_user_id_idx" ON "account" ("user_id");
    CREATE TABLE "scalius_schema_migrations" (
      "version" integer PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "source_sha256" text NOT NULL
    );
  `);
  return database;
}

function applyMigration(database: DatabaseSync): void {
  database.exec("BEGIN");
  try {
    for (const statement of migration) database.exec(statement);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

describe("Better Auth account identity migration", () => {
  it("backfills credential issuers without losing account data", () => {
    const database = legacyDatabase();
    try {
      database.exec(`
        INSERT INTO "user" ("id") VALUES ('user_1');
        INSERT INTO "account" VALUES (
          'account_1', 'user_1', 'user_1', 'credential', 'access', 'refresh',
          100, 200, 'scope', 'password-hash', 'id-token', 10, 20
        );
      `);

      applyMigration(database);

      expect(database.prepare(`
        SELECT id, user_id, account_id, provider_id, issuer, access_token,
          refresh_token, access_token_expires_at, refresh_token_expires_at,
          scope, password, id_token, created_at, updated_at
        FROM account
      `).get()).toEqual({
        id: "account_1",
        user_id: "user_1",
        account_id: "user_1",
        provider_id: "credential",
        issuer: "local:credential",
        access_token: "access",
        refresh_token: "refresh",
        access_token_expires_at: 100,
        refresh_token_expires_at: 200,
        scope: "scope",
        password: "password-hash",
        id_token: "id-token",
        created_at: 10,
        updated_at: 20,
      });
      expect(database.prepare(`
        SELECT "notnull" FROM pragma_table_info('account') WHERE name = 'issuer'
      `).get()).toEqual({ notnull: 1 });
      expect(() => database.exec(`
        INSERT INTO account (
          id, user_id, account_id, provider_id, issuer, password, created_at, updated_at
        ) VALUES (
          'account_2', 'user_1', 'user_1', 'credential', 'local:credential',
          'password-hash', 30, 30
        )
      `)).toThrow(/unique constraint failed/i);
    } finally {
      database.close();
    }
  });

  it.each([
    ["unknown provider", "('account_1', 'user_1', 'user_1', 'google', 'password-hash', 10, 20)", /better_auth_credential_identity_guard/i],
    ["malformed credential", "('account_1', 'user_1', 'other_user', 'credential', 'password-hash', 10, 20)", /better_auth_credential_identity_guard/i],
    ["credential collision", "('account_1', 'user_1', 'user_1', 'credential', 'password-hash', 10, 20), ('account_2', 'user_1', 'user_1', 'credential', 'password-hash', 10, 20)", /unique constraint failed/i],
  ])("fails closed on %s", (_case, rows, expected) => {
    const database = legacyDatabase();
    try {
      database.exec(`
        INSERT INTO "user" ("id") VALUES ('user_1');
        INSERT INTO "account" (
          "id", "user_id", "account_id", "provider_id", "password", "created_at", "updated_at"
        ) VALUES ${rows};
      `);

      expect(() => applyMigration(database)).toThrow(expected);
      expect(database.prepare(`
        SELECT count(*) AS count FROM pragma_table_info('account') WHERE name = 'issuer'
      `).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
