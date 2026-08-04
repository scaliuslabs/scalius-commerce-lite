import { asc } from "drizzle-orm";

import { scaliusSchemaMigrations } from "./schema";
import type { Database } from "./types";

export const DATABASE_SCHEMA_CONTRACT_VERSION =
  "scalius-database-schema/v1" as const;

/**
 * First provider-neutral migration identity. Releases before this point used
 * Wrangler's D1 ledger or one-shot, fingerprinted external-provider imports.
 */
export const DATABASE_SCHEMA_LEGACY_BASELINE = {
  version: 49,
  name: "0049_checkout_side_effect_authority_fence",
  tursoSchemaObjects: 532,
  tursoSchemaSha256:
    "1d34f85ddd9c40e27170a378f5082c71ea0ceb7abfbb6c7c52bf041904fdb997",
  postgresSchemaBundleVersion: "scalius-postgres-schema/v1",
  postgresSchemaSha256:
    "6c34b131affc800a6c0912d5922d3e5ded04a131135b8f5c3d64c40e0c691baf",
} as const;

export const CURRENT_DATABASE_SCHEMA = {
  version: 53,
  name: "0053_checkout_language_authority",
} as const;

export const CURRENT_DATABASE_SCHEMA_MIGRATIONS = [
  {
    version: 50,
    name: "0050_schema_release_contract",
    sourceSha256: "4b7e98071b3874f0a1e512b3bac3a188fdfb087f9cb118df9cd0fd8a77205194",
  },
  {
    version: 51,
    name: "0051_orders_checkout_write_path",
    sourceSha256: "be810d0a125e0ab2900e89bfa70a05d67b3b280cc0092a19e1016792a09288cc",
  },
  {
    version: 52,
    name: "0052_remove_storefront_cache_queue",
    sourceSha256: "3f010183c503a22006650e8c01a746e83dc8f600bbb101075c8583c2f07cf62c",
  },
  {
    ...CURRENT_DATABASE_SCHEMA,
    sourceSha256: "eaac242dba1606345bde9433d3d883e56605b44ce3d6f52be3b999aa6a588e9d",
  },
] as const;

export interface DatabaseSchemaState {
  version: number;
  name: string;
}

export interface DatabaseSchemaMigration extends DatabaseSchemaState {
  sourceSha256: string;
}

function normalizeSchemaMigration(row: {
  version: unknown;
  name: unknown;
  sourceSha256: unknown;
}): DatabaseSchemaMigration {
  const version = Number(row.version);
  const name = typeof row.name === "string" ? row.name : "";
  const sourceSha256 = typeof row.sourceSha256 === "string"
    ? row.sourceSha256
    : "";
  if (
    !Number.isSafeInteger(version)
    || version < 1
    || !name
    || !/^[a-f0-9]{64}$/.test(sourceSha256)
  ) {
    throw new Error("Database schema migration authority is invalid.");
  }
  return { version, name, sourceSha256 };
}

export function assertDatabaseSchemaCompatible(
  rows: readonly {
    version: unknown;
    name: unknown;
    sourceSha256: unknown;
  }[] | undefined,
): DatabaseSchemaState {
  if (!rows || rows.length === 0) {
    throw new Error("Database schema migration authority is missing.");
  }
  const migrations = rows.map(normalizeSchemaMigration);
  if (migrations.length !== CURRENT_DATABASE_SCHEMA_MIGRATIONS.length) {
    throw new Error(
      `Database schema migration ledger has ${migrations.length} row(s); expected `
      + `${CURRENT_DATABASE_SCHEMA_MIGRATIONS.length}.`,
    );
  }
  for (let index = 0; index < migrations.length; index += 1) {
    const actual = migrations[index]!;
    const expected = CURRENT_DATABASE_SCHEMA_MIGRATIONS[index]!;
    if (
      actual.version !== expected.version
      || actual.name !== expected.name
      || actual.sourceSha256 !== expected.sourceSha256
    ) {
      throw new Error(
        `Database schema migration ledger diverges at version ${expected.version}.`,
      );
    }
  }
  return CURRENT_DATABASE_SCHEMA;
}

export async function readDatabaseSchemaState(
  database: Database,
): Promise<DatabaseSchemaState> {
  const rows = await database
    .select({
      version: scaliusSchemaMigrations.version,
      name: scaliusSchemaMigrations.name,
      sourceSha256: scaliusSchemaMigrations.sourceSha256,
    })
    .from(scaliusSchemaMigrations)
    .orderBy(asc(scaliusSchemaMigrations.version))
    .all();
  return assertDatabaseSchemaCompatible(rows);
}
