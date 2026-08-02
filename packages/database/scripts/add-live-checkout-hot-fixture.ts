import {
  connect,
  type Connection,
  type SQLInputValue,
} from "@tursodatabase/serverless";
import { pathToFileURL } from "node:url";

import { assertDisposableDatabaseTarget } from "./live-checkout-load-core";

type QueryRow = Record<string, unknown>;

interface HotFixtureOptions {
  databaseUrl: string;
  databaseToken: string;
  acknowledgedDatabaseHostname: string;
  targetId: string;
  acknowledgedTargetId: string;
  suffix: string;
  stock: number;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readOptions(): HotFixtureOptions {
  const suffix = requiredEnvironment("LOADTEST_HOT_FIXTURE_SUFFIX").toLowerCase();
  if (!/^[a-z0-9]{1,20}$/.test(suffix)) {
    throw new Error("LOADTEST_HOT_FIXTURE_SUFFIX must be 1-20 lowercase letters or digits.");
  }
  const stock = Number(requiredEnvironment("LOADTEST_HOT_FIXTURE_STOCK"));
  if (!Number.isSafeInteger(stock) || stock < 1 || stock > 1_000_000) {
    throw new Error("LOADTEST_HOT_FIXTURE_STOCK must be an integer from 1 to 1000000.");
  }
  return {
    databaseUrl: requiredEnvironment("TURSO_DATABASE_URL"),
    databaseToken: requiredEnvironment("TURSO_AUTH_TOKEN"),
    acknowledgedDatabaseHostname: requiredEnvironment(
      "LOADTEST_ACK_DATABASE_HOST",
    ),
    targetId: requiredEnvironment("LOADTEST_TARGET_ID"),
    acknowledgedTargetId: requiredEnvironment("LOADTEST_ACK_TARGET_ID"),
    suffix,
    stock,
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

export async function addLiveCheckoutHotFixture(
  options: HotFixtureOptions,
): Promise<Record<string, string | number | boolean>> {
  const connection = connect({
    url: options.databaseUrl,
    authToken: options.databaseToken,
  });
  try {
    const sentinelRows = await query(
      connection,
      `SELECT target_id, purpose, database_hostname, fixture_namespace
         FROM scalius_loadtest_target`,
    );
    const identity = assertDisposableDatabaseTarget({
      databaseUrl: options.databaseUrl,
      acknowledgedDatabaseHostname: options.acknowledgedDatabaseHostname,
      expectedTargetId: options.targetId,
      acknowledgedTargetId: options.acknowledgedTargetId,
      sentinelRows,
    });
    const productId = `${identity.fixtureNamespace}_product_hot_${options.suffix}`;
    const variantId = `${identity.fixtureNamespace}_variant_hot_${options.suffix}`;
    const slug = `${identity.fixtureNamespace.replaceAll("_", "-")}-hot-${options.suffix}`;
    const sku = `${identity.targetId}-HOT-${options.suffix}`.toUpperCase();
    const existing = await query(
      connection,
      `SELECT p.id AS product_id, p.slug, p.is_active, p.deleted_at,
              v.id AS variant_id, v.stock, v.reserved_stock,
              v.track_inventory, v.stock_version
         FROM products p
         LEFT JOIN product_variants v ON v.product_id = p.id AND v.id = ?
        WHERE p.id = ?`,
      [variantId, productId],
    );
    if (existing.length > 0) {
      const row = existing[0]!;
      if (
        row.product_id !== productId || row.variant_id !== variantId ||
        row.slug !== slug || Number(row.is_active) !== 1 || row.deleted_at !== null ||
        Number(row.stock) !== options.stock || Number(row.reserved_stock) !== 0 ||
        Number(row.track_inventory) !== 1 || Number(row.stock_version) !== 1
      ) {
        throw new Error("Existing hot fixture does not match the requested disposable fixture.");
      }
      return {
        targetId: identity.targetId,
        productId,
        variantId,
        slug,
        stock: options.stock,
        alreadyExists: true,
      };
    }

    await connection.batch([
      {
        sql: `INSERT INTO products
                (id, name, description, price, slug, no_index,
                 exclude_from_sitemap, exclude_from_product_feed, is_active)
              VALUES (?, ?, 'Synthetic isolated hot-contention fixture.',
                      2499, ?, 1, 1, 1, 1)`,
        args: [productId, `Disposable Atomic Hot Fixture ${options.suffix}`, slug],
      },
      {
        sql: `INSERT INTO product_variants
                (id, product_id, option_combination_key, sku, price, stock,
                 reserved_stock, preorder_stock, is_default, track_inventory,
                 stock_version)
              VALUES (?, ?, NULL, ?, 2499, ?, 0, 0, 1, 1, 1)`,
        args: [variantId, productId, sku, options.stock],
      },
    ], "immediate");

    return {
      targetId: identity.targetId,
      productId,
      variantId,
      slug,
      stock: options.stock,
      alreadyExists: false,
    };
  } finally {
    connection.close();
  }
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(
    await addLiveCheckoutHotFixture(readOptions()),
  )}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
