import {
  connect,
  type Connection,
  type SQLInputValue,
} from "@tursodatabase/serverless";
import { pathToFileURL } from "node:url";

import {
  assertDisposableDatabaseProvisionTarget,
  assertDisposableDatabaseTarget,
  LOADTEST_TARGET_PURPOSE,
  type LoadTargetIdentity,
} from "./live-checkout-load-core";

type QueryRow = Record<string, unknown>;

interface SeedTargetOptions {
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
  return {
    databaseUrl: requiredEnvironment("TURSO_DATABASE_URL"),
    databaseToken: requiredEnvironment("TURSO_AUTH_TOKEN"),
    acknowledgedDatabaseHostname: requiredEnvironment(
      "LOADTEST_ACK_DATABASE_HOST",
    ),
    targetId: requiredEnvironment("LOADTEST_TARGET_ID"),
    acknowledgedTargetId: requiredEnvironment("LOADTEST_ACK_TARGET_ID"),
  };
}

async function query(
  connection: Connection,
  sql: string,
  args: readonly SQLInputValue[] = [],
): Promise<QueryRow[]> {
  const statement = await connection.prepare(sql);
  return await statement.all([...args]) as QueryRow[];
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

async function readSentinelRows(connection: Connection): Promise<QueryRow[]> {
  return query(
    connection,
    `SELECT target_id, purpose, database_hostname, fixture_namespace
       FROM scalius_loadtest_target`,
  );
}

async function verifySeededTarget(
  connection: Connection,
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
  const fixtureRows = await query(
    connection,
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
  const [integrityRows, foreignKeyRows, journalRows] = await Promise.all([
    query(connection, "PRAGMA integrity_check"),
    query(connection, "PRAGMA foreign_key_check"),
    query(connection, "PRAGMA journal_mode"),
  ]);
  const integrity = String(Object.values(integrityRows[0] ?? {})[0] ?? "").toLowerCase();
  const journalMode = String(Object.values(journalRows[0] ?? {})[0] ?? "").toLowerCase();
  if (integrity !== "ok" || foreignKeyRows.length !== 0 || journalMode !== "mvcc") {
    throw new Error("Seeded load-test target failed TursoDB integrity checks.");
  }
  return {
    targetId: identity.targetId,
    databaseHostname: identity.databaseHostname,
    fixtureNamespace: identity.fixtureNamespace,
    journalMode,
    integrity,
    foreignKeyViolations: foreignKeyRows.length,
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
  const connection = connect({
    url: options.databaseUrl,
    authToken: options.databaseToken,
  });
  try {
    const journalRows = await query(connection, "PRAGMA journal_mode");
    const journalMode = String(Object.values(journalRows[0] ?? {})[0] ?? "").toLowerCase();
    if (journalMode !== "mvcc") {
      throw new Error(`Load-test target journal mode is ${journalMode || "empty"}, not mvcc.`);
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
    const schemaRows = await query(
      connection,
      `SELECT name FROM sqlite_schema
        WHERE type = 'table'
          AND name IN (${requiredTables.map(() => "?").join(", ")})`,
      requiredTables,
    );
    if (schemaRows.length !== requiredTables.length) {
      throw new Error("Load-test target is missing the canonical application schema.");
    }

    const sentinelTableRows = await query(
      connection,
      `SELECT COUNT(*) AS sentinel_table_count
         FROM sqlite_schema
        WHERE type = 'table' AND name = 'scalius_loadtest_target'`,
    );
    if (scalarNumber(sentinelTableRows, "sentinel_table_count") === 1) {
      return {
        ...(await verifySeededTarget(connection, options)),
        alreadySeeded: true,
      };
    }

    const countRows = await query(
      connection,
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
    ], "immediate");

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
