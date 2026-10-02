// PostgreSQL sidecar for 0109_inventory_purchasing, on the upgrade path a
// real PostgreSQL store follows (the fresh 0103 schema plus every later
// sidecar), over populated rows: existing stock, levels, movements and order
// lines survive, and the new rules hold exactly as on SQLite (ledger
// semantics for received/transfer movements, cost guards, the order-line
// cost snapshot, purchase order line locks, append-only receipts and the
// purchase order/transfer events). The upgraded schema also matches the
// fresh one compiled from the canonical SQLite chain.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, types } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server.
const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const sidecar = (name: string) => join(import.meta.dirname, `../migrations/postgres/${name}.sql`);
const earlier = ["0104_custom_fields", "0105_plugin_runtime", "0106_theme_document_v6", "0107_plugin_platform", "0108_customer_marketing"];

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_inv_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresUrl!);
  url.pathname = `/${name}`;
  const client = new Client({
    connectionString: url.toString(),
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        oid === 20 ? Number : types.getTypeParser(oid, format)) as typeof types.getTypeParser,
    },
  });
  await client.connect();
  await client.query(schemaSql);
  openClients.push(async () => {
    await client.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  return client;
}

async function applySidecar(client: Client, name: string): Promise<void> {
  const sql = readFileSync(sidecar(name), "utf8");
  await client.query("BEGIN");
  try {
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function upgradedTo0108(): Promise<Client> {
  const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
  const client = await database(before.sql);
  for (const name of earlier) await applySidecar(client, name);
  return client;
}

async function rejects(client: Client, sql: string, pattern: RegExp): Promise<void> {
  await client.query("SAVEPOINT guard");
  try {
    await expect(client.query(sql)).rejects.toThrow(pattern);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT guard");
  }
}

async function catalog(client: Client) {
  const query = async (sql: string) => (await client.query(sql)).rows;
  return {
    columns: await query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'scalius_schema_migrations'
      ORDER BY table_name, column_name
    `),
    constraints: await query(`
      SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2, 3
    `),
    indexes: await query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname`),
    triggers: await query(`
      SELECT tgrelid::regclass::text AS table_name, tgname, pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2
    `),
    functions: await query(`
      SELECT p.proname, pg_get_functiondef(p.oid) AS definition FROM pg_proc p
      WHERE p.pronamespace = 'scalius_compat'::regnamespace ORDER BY p.proname, 2
    `),
  };
}

const MOVEMENT_COLUMNS = `id, variant_id, type, quantity, previous_stock, new_stock, ledger_version, pool,
  stock_version_before, stock_version_after, stock_delta, previous_reserved_stock, new_reserved_stock,
  reserved_stock_delta, previous_preorder_stock, new_preorder_stock, preorder_stock_delta, location_id`;

const movement = (id: string, type: string, quantity: number, delta: number, location: string | null, before: number, version: number) => `
  INSERT INTO inventory_movements (${MOVEMENT_COLUMNS})
  VALUES ('${id}', 'var_1', '${type}', ${quantity}, ${before}, ${before + delta}, 2, 'regular', ${version},
    ${version + 1}, ${delta}, 0, 0, 0, 0, 0, 0, ${location === null ? "NULL" : `'${location}'`})`;

describe.runIf(postgresUrl)("0109 inventory purchasing PostgreSQL sidecar", () => {
  it("upgrades a populated store and enforces the same rules as SQLite", async () => {
    const client = await upgradedTo0108();
    // A schema-only compile carries no rows: the default location 0102 inserted comes with the data.
    await client.query(`
      INSERT INTO inventory_locations (id, name, code, kind, is_default, status, position)
        VALUES ('loc_default', 'Main location', 'MAIN', 'warehouse', 1, 'active', 0);
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_1', 'Kurta', 'kurta', 80000, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
        VALUES ('var_1', 'prod_1', 'KURTA', 80000, 5, 0, 1, 1, 1);
      INSERT INTO inventory_locations (id, name, code, kind, is_default, status, position)
        VALUES ('loc_b', 'Branch', 'BR', 'store', 0, 'active', 1);
      INSERT INTO inventory_movements (id, variant_id, type, quantity, previous_stock, new_stock, ledger_version)
        VALUES ('legacy_v1', 'var_1', 'adjusted', 2, 3, 5, 1);
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
        VALUES ('ord_1', 'Rahim', '+8801711111111', 'House 1', 'c', 'z', 'confirmed');
      INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, unit_price_minor)
        VALUES ('item_old', 'ord_1', 'prod_1', 'var_1', 1, 'Kurta', 80000);
    `);
    await applySidecar(client, "0109_inventory_purchasing");
    expect((await client.query("SELECT stock, cost_minor FROM product_variants")).rows).toEqual([{ stock: 5, cost_minor: null }]);
    expect((await client.query("SELECT location_id, on_hand FROM inventory_levels")).rows).toEqual([{ location_id: "loc_default", on_hand: 5 }]);
    expect((await client.query("SELECT unit_cost_minor FROM order_items")).rows).toEqual([{ unit_cost_minor: null }]);
    expect((await client.query("SELECT version, name FROM scalius_schema_migrations WHERE version = 109")).rows)
      .toEqual([{ version: 109, name: "0109_inventory_purchasing" }]);

    await client.query("BEGIN");
    // Ledger semantics: receipts and transfers move physical stock at a location.
    await client.query(movement("mv_in", "received", 4, 4, "loc_b", 5, 1));
    await client.query(movement("mv_out", "transfer_out", -3, -3, "loc_default", 9, 2));
    await client.query(movement("mv_tin", "transfer_in", 3, 3, "loc_b", 6, 3));
    expect((await client.query("SELECT location_id, on_hand FROM inventory_levels ORDER BY location_id")).rows).toEqual([
      { location_id: "loc_b", on_hand: 7 },
      { location_id: "loc_default", on_hand: 2 },
    ]);
    await rejects(client, movement("bad_sign", "received", -1, -1, "loc_b", 9, 4), /semantics/);
    await rejects(client, movement("bad_out", "transfer_out", 1, -1, "loc_b", 9, 4), /semantics/);
    await rejects(client, movement("short", "transfer_out", -5, -5, "loc_default", 9, 4), /INVENTORY_LEVEL_SHORTFALL/);
    await rejects(client, "UPDATE inventory_movements SET type = 'received' WHERE id = 'mv_out'", /semantics|immutable/);
    await client.query("UPDATE inventory_movements SET notes = 'checked' WHERE id = 'mv_in'");

    // Costs: guarded, snapshotted onto new order lines, frozen there.
    await rejects(client, "UPDATE product_variants SET cost_minor = -1", /PRODUCT_VARIANT_COST_INVALID/);
    await client.query("UPDATE product_variants SET cost_minor = 45000");
    await client.query(`INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, unit_price_minor)
      VALUES ('item_new', 'ord_1', 'prod_1', 'var_1', 1, 'Kurta', 80000)`);
    expect((await client.query("SELECT unit_cost_minor FROM order_items WHERE id = 'item_new'")).rows).toEqual([{ unit_cost_minor: 45000 }]);
    await rejects(client, "UPDATE order_items SET unit_cost_minor = 1 WHERE id = 'item_new'", /frozen/);

    // Purchase orders: lines lock once ordered; receipts and commands are append-only.
    await client.query(`
      INSERT INTO suppliers (id, name) VALUES ('sup_1', 'Dhaka Textiles');
      INSERT INTO purchase_orders (id, number, supplier_id, destination_location_id, currency_code) VALUES ('po_1', 1001, 'sup_1', 'loc_b', 'BDT');
      INSERT INTO purchase_order_lines (id, purchase_order_id, variant_id, quantity, unit_cost_minor) VALUES ('pol_1', 'po_1', 'var_1', 10, 40000);
      UPDATE purchase_orders SET status = 'ordered', revision = 2 WHERE id = 'po_1';
    `);
    await rejects(client, "UPDATE purchase_order_lines SET quantity = 20 WHERE id = 'pol_1'", /PURCHASE_ORDER_LINES_LOCKED/);
    await client.query(`
      INSERT INTO inventory_commands (operation_key, request_hash, command_type, subject_id, subject_revision, result_payload)
        VALUES ('op_1', 'h', 'purchase_order_receive', 'po_1', 3, '{}');
      INSERT INTO purchase_order_receipt_lines (id, operation_key, purchase_order_id, purchase_order_line_id, variant_id, location_id, movement_id, quantity, unit_cost_minor)
        VALUES ('porl_1', 'op_1', 'po_1', 'pol_1', 'var_1', 'loc_b', 'mv_in', 4, 40000);
      UPDATE purchase_order_lines SET received_quantity = 4 WHERE id = 'pol_1';
    `);
    await rejects(client, "UPDATE purchase_order_lines SET received_quantity = 3 WHERE id = 'pol_1'", /never decrease/);
    await rejects(client, "UPDATE purchase_order_receipt_lines SET quantity = 1", /immutable/);
    await rejects(client, "DELETE FROM inventory_commands", /immutable/);
    await rejects(client, `INSERT INTO inventory_commands (operation_key, request_hash, command_type, subject_id, subject_revision, result_payload)
      VALUES ('op_2', 'h', 'purchase_order_receive', 'po_1', 3, '{}')`, /inventory_commands_subject_revision_unique/);
    await rejects(client, `INSERT INTO inventory_transfers (id, number, origin_location_id, destination_location_id)
      VALUES ('trf_x', 1, 'loc_b', 'loc_b')`, /inventory_transfers_locations_differ/);

    const events = (await client.query(`SELECT topic, resource_type, data FROM event_outbox
      WHERE topic IN ('inventory.purchase_order_updated', 'inventory.transfer_updated')`)).rows as Array<{ topic: string; resource_type: string; data: string }>;
    expect(events.map((event) => [event.topic, event.resource_type, JSON.parse(event.data)])).toEqual(expect.arrayContaining([
      ["inventory.purchase_order_updated", "purchase_order", { purchaseOrderId: "po_1", previousStatus: null, status: "draft", revision: 1 }],
      ["inventory.purchase_order_updated", "purchase_order", { purchaseOrderId: "po_1", previousStatus: "draft", status: "ordered", revision: 2 }],
    ]));
    expect(events).toHaveLength(2);
    await client.query("ROLLBACK");
  }, 240_000);

  it("upgrades to exactly the schema compiled fresh from the canonical chain", async () => {
    const fresh = await compileCanonicalPostgresSchema({ beforeMigration: "0110_" });
    const freshDatabase = await database(fresh.sql);
    const upgraded = await upgradedTo0108();
    await applySidecar(upgraded, "0109_inventory_purchasing");
    const [expected, actual] = await Promise.all([catalog(freshDatabase), catalog(upgraded)]);
    // Everything 0109 creates or changes. (Other releases' own sidecar tests
    // cover theirs; 0104's custom_field_definitions_key_shape regex is
    // written `[a-z]` by its sidecar and `^[a-z]$` by the compiler, the same
    // check on one character.)
    const tables = new Set([
      "suppliers", "purchase_orders", "purchase_order_lines", "purchase_order_receipt_lines", "inventory_commands",
      "inventory_transfers", "inventory_transfer_lines", "inventory_transfer_movements", "product_variants",
      "order_items", "inventory_movements", "inventory_levels", "event_outbox",
    ]);
    const ofTables = <T extends Record<string, unknown>>(rows: T[]) =>
      rows.filter((row) => tables.has(String(row.table_name ?? row.tablename)));
    const functionNames = new Set([
      ...expected.triggers.filter((row) => tables.has(String(row.table_name))).map((row) => `${String(row.tgname)}_fn`),
    ]);
    const ofFunctions = <T extends Record<string, unknown>>(rows: T[]) => rows.filter((row) => functionNames.has(String(row.proname)));
    expect(ofTables(actual.columns)).toEqual(ofTables(expected.columns));
    expect(ofTables(actual.constraints)).toEqual(ofTables(expected.constraints));
    expect(ofTables(actual.indexes)).toEqual(ofTables(expected.indexes));
    expect(ofTables(actual.triggers)).toEqual(ofTables(expected.triggers));
    expect(ofFunctions(actual.functions)).toEqual(ofFunctions(expected.functions));
    expect(ofFunctions(expected.functions).length).toBeGreaterThan(20);
  }, 240_000);
});
