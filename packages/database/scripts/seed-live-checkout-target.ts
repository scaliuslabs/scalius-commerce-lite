import {
  connect,
  type SQLInputValue,
} from "@tursodatabase/serverless";
import { pathToFileURL } from "node:url";

import {
  connectPostgres,
  type PostgresHttpConnection,
} from "../src/postgres-adapter";
import {
  compileSqliteStatementForPostgres,
  normalizePostgresParameters,
  normalizePostgresResultObjects,
} from "../src/postgres-sqlite-profile";
import { assertDatabaseSchemaCompatible } from "../src/schema-contract";
import {
  assertDisposableDatabaseProvisionTarget,
  assertDisposableDatabaseTarget,
  LOADTEST_TARGET_PURPOSE,
  type LoadTargetIdentity,
} from "./live-checkout-load-core";

type QueryRow = Record<string, unknown>;
type SeedProvider = "turso" | "postgres";
type SeedValue = SQLInputValue | bigint | boolean | Uint8Array;
type SeedStatement = string | { sql: string; args: readonly SeedValue[] };

interface SeedConnection {
  query(sql: string, args?: readonly SeedValue[]): Promise<QueryRow[]>;
  batch(statements: readonly SeedStatement[]): Promise<void>;
  close(): Promise<void>;
}

interface SeedTargetOptions {
  provider: SeedProvider;
  databaseUrl: string;
  databaseToken: string;
  acknowledgedDatabaseHostname: string;
  targetId: string;
  acknowledgedTargetId: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readOptions(): SeedTargetOptions {
  const provider = requiredEnvironment("LOADTEST_DATABASE_PROVIDER").toLowerCase();
  if (provider !== "turso" && provider !== "postgres") {
    throw new Error("LOADTEST_DATABASE_PROVIDER must be turso or postgres for seeding.");
  }
  return {
    provider,
    databaseUrl: requiredEnvironment(
      provider === "turso" ? "TURSO_DATABASE_URL" : "POSTGRES_DATABASE_URL",
    ),
    databaseToken: provider === "turso"
      ? requiredEnvironment("TURSO_AUTH_TOKEN")
      : "",
    acknowledgedDatabaseHostname: requiredEnvironment(
      "LOADTEST_ACK_DATABASE_HOST",
    ),
    targetId: requiredEnvironment("LOADTEST_TARGET_ID"),
    acknowledgedTargetId: requiredEnvironment("LOADTEST_ACK_TARGET_ID"),
  };
}

function createTursoSeedConnection(options: SeedTargetOptions): SeedConnection {
  const connection = connect({
    url: options.databaseUrl,
    authToken: options.databaseToken,
  });
  return {
    async query(sql, args = []) {
      const statement = await connection.prepare(sql);
      return await statement.all([...args] as SQLInputValue[]) as QueryRow[];
    },
    async batch(statements) {
      await connection.batch(statements.map((statement) => typeof statement === "string"
        ? statement
        : { sql: statement.sql, args: [...statement.args] as SQLInputValue[] }), "immediate");
    },
    async close() {
      await connection.close();
    },
  };
}

function postgresRows(result: Awaited<ReturnType<PostgresHttpConnection["query"]>>): QueryRow[] {
  if (result.fields.some((field) => !field.name)) {
    throw new Error("PostgreSQL load seed result field is missing its name.");
  }
  return normalizePostgresResultObjects(
    result.rows,
    result.fields as { name: string; dataTypeID: number }[],
  );
}

function createPostgresSeedConnection(options: SeedTargetOptions): SeedConnection {
  const connection = connectPostgres(options.databaseUrl);
  return {
    async query(sql, args = []) {
      const compiled = compileSqliteStatementForPostgres(sql, args.length);
      return postgresRows(await connection.query(
        compiled.sql,
        normalizePostgresParameters(args),
      ));
    },
    async batch(statements) {
      const queries = statements.map((statement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        const args = typeof statement === "string" ? [] : statement.args;
        const compiled = compileSqliteStatementForPostgres(sql, args.length);
        return connection.query(compiled.sql, normalizePostgresParameters(args));
      });
      await connection.transaction(queries, {
        arrayMode: true,
        fullResults: true,
        isolationLevel: "Serializable",
        readOnly: false,
      });
    },
    async close() {
      // Neither transport retains a connection at this wrapper boundary.
    },
  };
}

function createSeedConnection(options: SeedTargetOptions): SeedConnection {
  return options.provider === "postgres"
    ? createPostgresSeedConnection(options)
    : createTursoSeedConnection(options);
}

function scalarNumber(rows: readonly QueryRow[], key: string): number {
  const value = Number(rows[0]?.[key]);
  if (!Number.isFinite(value)) {
    throw new Error(`Load-test seed query did not return numeric ${key}.`);
  }
  return value;
}

function fixtureValues(identity: LoadTargetIdentity) {
  const namespace = identity.fixtureNamespace;
  const slugNamespace = namespace.replaceAll("_", "-");
  return {
    cityId: `${namespace}_city`,
    zoneId: `${namespace}_zone`,
    areaId: `${namespace}_area`,
    shippingMethodId: `${namespace}_shipping`,
    spreadProductId: `${namespace}_product_spread`,
    spreadVariantId: `${namespace}_variant_spread`,
    spreadSlug: `${slugNamespace}-spread`,
    hotProductId: `${namespace}_product_hot`,
    hotVariantId: `${namespace}_variant_hot`,
    hotSlug: `${slugNamespace}-hot`,
  };
}

async function readSentinelRows(connection: SeedConnection): Promise<QueryRow[]> {
  return connection.query(
    `SELECT target_id, purpose, database_hostname, fixture_namespace
       FROM scalius_loadtest_target`,
  );
}

async function readSeedDatabaseHealth(
  connection: SeedConnection,
  provider: SeedProvider,
): Promise<{
  integrity: string;
  journalMode: string;
  foreignKeyViolations: number;
}> {
  if (provider === "postgres") {
    const [schemaRows, invalidForeignKeyRows] = await Promise.all([
      connection.query(
        `SELECT version, name, source_sha256
           FROM scalius_schema_migrations
          ORDER BY version`,
      ),
      connection.query(
        `SELECT conname
           FROM pg_constraint
          WHERE contype = 'f' AND NOT convalidated`,
      ),
    ]);
    assertDatabaseSchemaCompatible(schemaRows.map((row) => ({
      version: row.version,
      name: row.name,
      sourceSha256: row.source_sha256,
    })));
    if (invalidForeignKeyRows.length !== 0) {
      throw new Error("Seeded PostgreSQL load target has unvalidated foreign keys.");
    }
    return {
      integrity: "postgres-constraints",
      journalMode: "postgres-mvcc",
      foreignKeyViolations: 0,
    };
  }

  const [integrityRows, foreignKeyRows, journalRows] = await Promise.all([
    connection.query("PRAGMA integrity_check"),
    connection.query("PRAGMA foreign_key_check"),
    connection.query("PRAGMA journal_mode"),
  ]);
  const integrity = String(Object.values(integrityRows[0] ?? {})[0] ?? "").toLowerCase();
  const journalMode = String(Object.values(journalRows[0] ?? {})[0] ?? "").toLowerCase();
  if (integrity !== "ok" || foreignKeyRows.length !== 0 || journalMode !== "mvcc") {
    throw new Error("Seeded load-test target failed TursoDB integrity checks.");
  }
  return {
    integrity,
    journalMode,
    foreignKeyViolations: foreignKeyRows.length,
  };
}

async function verifySeededTarget(
  connection: SeedConnection,
  options: SeedTargetOptions,
): Promise<Record<string, string | number | boolean>> {
  const identity = assertDisposableDatabaseTarget({
    databaseUrl: options.databaseUrl,
    acknowledgedDatabaseHostname: options.acknowledgedDatabaseHostname,
    expectedTargetId: options.targetId,
    acknowledgedTargetId: options.acknowledgedTargetId,
    sentinelRows: await readSentinelRows(connection),
  });
  const fixture = fixtureValues(identity);
  const fixtureRows = await connection.query(
    `SELECT COUNT(*) AS fixture_count
       FROM products p
       JOIN product_variants v ON v.product_id = p.id
      WHERE (p.id = ? AND v.id = ? AND v.track_inventory = 0)
         OR (p.id = ? AND v.id = ? AND v.track_inventory = 1
             AND v.stock = 50 AND v.reserved_stock = 0)`,
    [
      fixture.spreadProductId,
      fixture.spreadVariantId,
      fixture.hotProductId,
      fixture.hotVariantId,
    ],
  );
  if (scalarNumber(fixtureRows, "fixture_count") !== 2) {
    throw new Error("Load-test target fixtures do not match the sentinel identity.");
  }
  const health = await readSeedDatabaseHealth(connection, options.provider);
  return {
    targetId: identity.targetId,
    databaseHostname: identity.databaseHostname,
    fixtureNamespace: identity.fixtureNamespace,
    ...health,
    spreadProductId: fixture.spreadProductId,
    spreadVariantId: fixture.spreadVariantId,
    hotProductId: fixture.hotProductId,
    hotVariantId: fixture.hotVariantId,
    cityId: fixture.cityId,
    zoneId: fixture.zoneId,
    areaId: fixture.areaId,
    shippingMethodId: fixture.shippingMethodId,
    shippingCharge: 99,
  };
}

export async function seedLiveCheckoutTarget(
  options: SeedTargetOptions,
): Promise<Record<string, string | number | boolean>> {
  const identity = assertDisposableDatabaseProvisionTarget({
    databaseUrl: options.databaseUrl,
    acknowledgedDatabaseHostname: options.acknowledgedDatabaseHostname,
    expectedTargetId: options.targetId,
    acknowledgedTargetId: options.acknowledgedTargetId,
  });
  const connection = createSeedConnection(options);
  try {
    if (options.provider === "turso") {
      const journalRows = await connection.query("PRAGMA journal_mode");
      const journalMode = String(Object.values(journalRows[0] ?? {})[0] ?? "").toLowerCase();
      if (journalMode !== "mvcc") {
        throw new Error(`Load-test target journal mode is ${journalMode || "empty"}, not mvcc.`);
      }
    }

    const requiredTables = [
      "customers",
      "delivery_locations",
      "orders",
      "product_variants",
      "products",
      "settings",
      "shipping_methods",
      "site_settings",
    ];
    const schemaRows = await connection.query(
      options.provider === "postgres"
        ? `SELECT table_name AS name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN (${requiredTables.map(() => "?").join(", ")})`
        : `SELECT name FROM sqlite_schema
            WHERE type = 'table'
              AND name IN (${requiredTables.map(() => "?").join(", ")})`,
      requiredTables,
    );
    if (schemaRows.length !== requiredTables.length) {
      throw new Error("Load-test target is missing the canonical application schema.");
    }

    const sentinelTableRows = await connection.query(
      options.provider === "postgres"
        ? `SELECT COUNT(*) AS sentinel_table_count
             FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'scalius_loadtest_target'`
        : `SELECT COUNT(*) AS sentinel_table_count
             FROM sqlite_schema
            WHERE type = 'table' AND name = 'scalius_loadtest_target'`,
    );
    if (scalarNumber(sentinelTableRows, "sentinel_table_count") === 1) {
      return {
        ...(await verifySeededTarget(connection, options)),
        alreadySeeded: true,
      };
    }

    const countRows = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM products) AS products_count,
         (SELECT COUNT(*) FROM product_variants) AS variants_count,
         (SELECT COUNT(*) FROM orders) AS orders_count,
         (SELECT COUNT(*) FROM customers) AS customers_count,
         (SELECT COUNT(*) FROM settings) AS settings_count,
         (SELECT COUNT(*) FROM site_settings) AS site_settings_count,
         (SELECT COUNT(*) FROM shipping_methods) AS shipping_methods_count,
         (SELECT COUNT(*) FROM delivery_locations) AS delivery_locations_count`,
    );
    for (const [key, value] of Object.entries(countRows[0] ?? {})) {
      if (Number(value) !== 0) {
        throw new Error(
          `Refusing to seed non-empty load-test target: ${key} is ${String(value)}.`,
        );
      }
    }

    const fixture = fixtureValues(identity);
    const now = Math.floor(Date.now() / 1_000);
    await connection.batch([
      `CREATE TABLE scalius_loadtest_target (
         target_id TEXT PRIMARY KEY,
         purpose TEXT NOT NULL,
         database_hostname TEXT NOT NULL,
         fixture_namespace TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
      {
        sql: `INSERT INTO scalius_loadtest_target
                (target_id, purpose, database_hostname, fixture_namespace, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          identity.targetId,
          LOADTEST_TARGET_PURPOSE,
          identity.databaseHostname,
          identity.fixtureNamespace,
          now,
        ],
      },
      {
        sql: `INSERT INTO site_settings
                (id, singleton_key, site_name, header_config, footer_config,
                 guest_checkout_enabled, checkout_mode, partial_payment_enabled,
                 partial_payment_amount)
              VALUES (?, 'default', 'Scalius Loadtest', '{}', '{}', 1,
                      'guest_cod_only', 0, 0)`,
        args: [`${identity.targetId}_site`],
      },
      ...[
        ["currency_code", "BDT", "string", "currency"],
        ["currency_symbol", "৳", "string", "currency"],
        ["usd_exchange_rate", "110", "number", "currency"],
        ["enabled_methods", '["cod"]', "json", "payment_methods"],
        ["default_method", "cod", "string", "payment_methods"],
        [
          "allowed_countries",
          '{"countries":["BD"],"mode":"include"}',
          "json",
          "phone",
        ],
      ].map(([key, value, type, category], index) => ({
        sql: `INSERT INTO settings (id, key, value, type, category)
              VALUES (?, ?, ?, ?, ?)`,
        args: [`${identity.targetId}_setting_${index}`, key!, value!, type!, category!],
      })),
      {
        sql: `INSERT INTO shipping_methods
                (id, name, fee, description, is_active, sort_order)
              VALUES (?, ?, 99, 'Synthetic load-test delivery', 1, 0)`,
        args: [fixture.shippingMethodId, `${identity.targetId} delivery`],
      },
      {
        sql: `INSERT INTO delivery_locations
                (id, name, type, parent_id, external_ids, metadata, is_active, sort_order)
              VALUES (?, 'Loadtest City', 'city', NULL, '{}', '{}', 1, 0)`,
        args: [fixture.cityId],
      },
      {
        sql: `INSERT INTO delivery_locations
                (id, name, type, parent_id, external_ids, metadata, is_active, sort_order)
              VALUES (?, 'Loadtest Zone', 'zone', ?, '{}', '{}', 1, 0)`,
        args: [fixture.zoneId, fixture.cityId],
      },
      {
        sql: `INSERT INTO delivery_locations
                (id, name, type, parent_id, external_ids, metadata, is_active, sort_order)
              VALUES (?, 'Loadtest Area', 'area', ?, '{}', '{}', 1, 0)`,
        args: [fixture.areaId, fixture.zoneId],
      },
      {
        sql: `INSERT INTO products
                (id, name, description, price, slug, no_index,
                 exclude_from_sitemap, exclude_from_product_feed, is_active)
              VALUES (?, 'Disposable Atomic Spread Fixture',
                      'Synthetic isolated load-test fixture.', 1999, ?, 1, 1, 1, 1)`,
        args: [fixture.spreadProductId, fixture.spreadSlug],
      },
      {
        sql: `INSERT INTO product_variants
                (id, product_id, option_combination_key, sku, price, stock,
                 reserved_stock, preorder_stock, is_default, track_inventory,
                 stock_version)
              VALUES (?, ?, NULL, ?, 1999, 0, 0, 0, 1, 0, 1)`,
        args: [
          fixture.spreadVariantId,
          fixture.spreadProductId,
          `${identity.targetId}-SPREAD`.toUpperCase(),
        ],
      },
      {
        sql: `INSERT INTO products
                (id, name, description, price, slug, no_index,
                 exclude_from_sitemap, exclude_from_product_feed, is_active)
              VALUES (?, 'Disposable Atomic Hot Fixture',
                      'Synthetic isolated load-test fixture.', 2499, ?, 1, 1, 1, 1)`,
        args: [fixture.hotProductId, fixture.hotSlug],
      },
      {
        sql: `INSERT INTO product_variants
                (id, product_id, option_combination_key, sku, price, stock,
                 reserved_stock, preorder_stock, is_default, track_inventory,
                 stock_version)
              VALUES (?, ?, NULL, ?, 2499, 50, 0, 0, 1, 1, 1)`,
        args: [
          fixture.hotVariantId,
          fixture.hotProductId,
          `${identity.targetId}-HOT`.toUpperCase(),
        ],
      },
    ]);

    return {
      ...(await verifySeededTarget(connection, options)),
      alreadySeeded: false,
    };
  } finally {
    await connection.close();
  }
}

async function main(): Promise<void> {
  process.stdout.write(
    `${JSON.stringify(await seedLiveCheckoutTarget(readOptions()))}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
