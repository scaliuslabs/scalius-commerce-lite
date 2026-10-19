import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { compileSqliteMigrationForProvider } from "../src/migration-artifacts";
import {
  CURRENT_DATABASE_SCHEMA,
  DATABASE_SCHEMA_LEGACY_BASELINE,
} from "../src/schema-contract";
import {
  buildPostgresSchemaUpgradeGuard,
  POSTGRES_SCHEMA_UPGRADE_ALREADY_APPLIED_CODE,
  POSTGRES_SCHEMA_UPGRADE_BUSY_CODE,
  splitSchemaMigrationStatements,
  validateAppliedSchemaMigrations,
} from "../src/schema-upgrade";
import {
  compileSqliteDdlForPostgres,
} from "../scripts/postgres-schema";
import {
  POSTGRES_MIGRATION_STATE_REGCLASS,
  POSTGRES_MIGRATION_STATE_TABLE,
  postgresMigrationControlTable,
} from "../src/postgres-migration-control";
import {
  buildPostgresMigrationControlSql,
  SQLITE_TO_POSTGRES_CHECKPOINT_VERSION,
} from "../scripts/migrate-sqlite-to-postgres";
import type { PostgresFullResult, PostgresHttpConnection } from "../src/postgres-adapter";
import {
  applyPostgresSchemaUpgrades,
  applyTursoSchemaUpgrades,
  EMPTY_SCHEMA_STATE,
  inspectTursoSchemaUpgrade,
  loadSchemaUpgradeArtifacts,
  type TursoSchemaConnection,
} from "../scripts/upgrade-provider-schema";
import { connect } from "@tursodatabase/database";
import { createProviderSchemaDatabase } from "../scripts/sqlite-provider-schema";
import { tursoEngineConnection } from "./turso-engine";

const migrationsDirectory = resolve(import.meta.dirname, "../migrations");

function createLegacyTursoDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const filename of readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0050_")
    .sort()) {
    database.exec(compileSqliteMigrationForProvider(
      readFileSync(join(migrationsDirectory, filename), "utf8"),
      "turso",
    ));
  }
  return database;
}

function createLocalTursoConnection(database: DatabaseSync): TursoSchemaConnection {
  const all = async (sql: string, ...params: unknown[]) =>
    database.prepare(sql).all(...params as SQLInputValue[]);
  return {
    all,
    transactionAsync<T>(callback: (transaction: {
      all: typeof all;
      batch(statements: string[]): Promise<unknown>;
    }) => Promise<T>) {
      return {
        async immediate() {
          database.exec("BEGIN IMMEDIATE");
          try {
            const result = await callback({
              all,
              async batch(statements) {
                for (const statement of statements) database.exec(statement);
                return [];
              },
            });
            database.exec("COMMIT");
            return result;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        },
      };
    },
    async close() {},
  };
}

function postgresResult(rows: unknown[][]): PostgresFullResult {
  return { rows, fields: [] };
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

describe("provider-neutral schema upgrades", { timeout: 30_000 }, () => {
  it("loads a contiguous migration chain with exact Turso and PostgreSQL sidecars", async () => {
    const artifacts = await loadSchemaUpgradeArtifacts();
    expect(artifacts.map((artifact) => ({
      version: artifact.version,
      name: artifact.name,
      sqliteStatements: artifact.sqliteStatements.length,
      postgresStatements: artifact.postgresStatements.length,
    }))).toEqual([
      {
        version: 50,
        name: "0050_schema_release_contract",
        sqliteStatements: 3,
        postgresStatements: 3,
      },
      {
        version: 51,
        name: "0051_orders_checkout_write_path",
        sqliteStatements: 10,
        postgresStatements: 10,
      },
      {
        version: 52,
        name: "0052_remove_storefront_cache_queue",
        sqliteStatements: 2,
        postgresStatements: 2,
      },
      {
        version: 53,
        name: "0053_checkout_language_authority",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 54,
        name: "0054_cache_invalidation_delivery",
        sqliteStatements: 2,
        postgresStatements: 2,
      },
      {
        version: 55,
        name: "0055_cache_invalidation_postgres_bigint",
        sqliteStatements: 2,
        postgresStatements: 2,
      },
      {
        version: 56,
        name: "0056_agent_access",
        sqliteStatements: 46,
        postgresStatements: 46,
      },
      {
        version: 57,
        name: "0057_agent_browser_handoffs",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 58,
        name: "0058_order_shipping_method_snapshot",
        sqliteStatements: 6,
        postgresStatements: 6,
      },
      {
        version: 59,
        name: "0059_checkout_delivery_phone_identity",
        sqliteStatements: 6,
        postgresStatements: 10,
      },
      {
        version: 60,
        name: "0060_better_auth_account_identity",
        sqliteStatements: 10,
        postgresStatements: 6,
      },
      {
        version: 61,
        name: "0061_regular_hex",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 62,
        name: "0062_identity_handoff_audit",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 63,
        name: "0063_media_variants_drop_polar",
        sqliteStatements: 5,
        postgresStatements: 6,
      },
      {
        version: 64,
        name: "0064_cache_generation",
        sqliteStatements: 3,
        postgresStatements: 3,
      },
      {
        version: 65,
        name: "0065_single_checkout_commit",
        sqliteStatements: 51,
        postgresStatements: 56,
      },
      {
        version: 66,
        name: "0066_payment_provider_refs",
        sqliteStatements: 17,
        postgresStatements: 17,
      },
      {
        version: 67,
        name: "0067_settings_documents",
        sqliteStatements: 29,
        postgresStatements: 29,
      },
      {
        version: 68,
        name: "0068_single_discount_engine",
        sqliteStatements: 15,
        postgresStatements: 21,
      },
      {
        version: 69,
        name: "0069_integer_money",
        sqliteStatements: 103,
        postgresStatements: 52,
      },
      {
        version: 70,
        name: "0070_order_numbers_timeline",
        sqliteStatements: 11,
        postgresStatements: 11,
      },
      {
        version: 71,
        name: "0071_buyer_identity",
        sqliteStatements: 8,
        postgresStatements: 8,
      },
      {
        version: 72,
        name: "0072_delivery_zones",
        sqliteStatements: 19,
        postgresStatements: 21,
      },
      {
        version: 73,
        name: "0073_combinable_discount_codes",
        sqliteStatements: 3,
        postgresStatements: 3,
      },
      {
        version: 74,
        name: "0074_verified_customer_identity",
        sqliteStatements: 7,
        postgresStatements: 7,
      },
      {
        version: 75,
        name: "0075_theme_layout_reset",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 76,
        name: "0076_guest_record_links",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 77,
        name: "0077_optioned_product_price",
        sqliteStatements: 2,
        postgresStatements: 2,
      },
      {
        version: 78,
        name: "0078_theme_document_v2",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 79,
        name: "0079_guest_record_origin",
        sqliteStatements: 10,
        postgresStatements: 10,
      },
      {
        version: 80,
        name: "0080_whole_taka_amounts",
        sqliteStatements: 9,
        postgresStatements: 9,
      },
      {
        version: 81,
        name: "0081_theme_document_v3",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 82,
        name: "0082_theme_document_v4",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 83,
        name: "0083_order_line_fulfilment",
        sqliteStatements: 52,
        postgresStatements: 59,
      },
      {
        version: 84,
        name: "0084_line_item_properties",
        sqliteStatements: 9,
        postgresStatements: 11,
      },
      {
        version: 85,
        name: "0085_conversations",
        sqliteStatements: 29,
        postgresStatements: 37,
      },
      {
        version: 86,
        name: "0086_notification_outbox",
        sqliteStatements: 20,
        postgresStatements: 20,
      },
      {
        version: 87,
        name: "0087_on_sale_indexes",
        sqliteStatements: 3,
        postgresStatements: 3,
      },
      {
        version: 88,
        name: "0088_wave_a_contract",
        sqliteStatements: 14,
        postgresStatements: 17,
      },
      {
        version: 89,
        name: "0089_wave_a_contract_columns",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 90,
        name: "0090_catalogue_schema",
        sqliteStatements: 77,
        postgresStatements: 97,
      },
      {
        version: 91,
        name: "0091_catalogue_projection_fill",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 92,
        name: "0092_attribute_option_presets",
        sqliteStatements: 2,
        postgresStatements: 2,
      },
      {
        version: 93,
        name: "0093_theme_document_v5",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 94,
        name: "0094_media_rendition_ladder",
        sqliteStatements: 2,
        postgresStatements: 2,
      },
      {
        version: 95,
        name: "0095_reviews",
        sqliteStatements: 22,
        postgresStatements: 30,
      },
      {
        version: 96,
        name: "0096_digital_goods",
        sqliteStatements: 20,
        postgresStatements: 22,
      },
      {
        version: 97,
        name: "0097_gift_cards",
        sqliteStatements: 23,
        postgresStatements: 33,
      },
      {
        version: 98,
        name: "0098_warranty",
        sqliteStatements: 24,
        postgresStatements: 30,
      },
      {
        version: 99,
        name: "0099_customer_whatsapp",
        sqliteStatements: 2,
        postgresStatements: 2,
      },
      {
        version: 100,
        name: "0100_cache_dependencies",
        sqliteStatements: 222,
        postgresStatements: 221,
      },
      {
        version: 101,
        name: "0101_cache_ordering_dependencies",
        sqliteStatements: 20,
        postgresStatements: 20,
      },
      {
        version: 102,
        name: "0102_inventory_locations",
        sqliteStatements: 30,
        postgresStatements: 37,
      },
      {
        version: 103,
        name: "0103_order_channel_event_outbox",
        sqliteStatements: 48,
        postgresStatements: 44,
      },
      {
        version: 104,
        name: "0104_custom_fields",
        sqliteStatements: 43,
        postgresStatements: 43,
      },
      {
        version: 105,
        name: "0105_plugin_runtime",
        sqliteStatements: 18,
        postgresStatements: 18,
      },
      {
        version: 106,
        name: "0106_theme_document_v6",
        // T1 theme reset (5) + T2 retired tables/documents; Postgres also drops the hero trigger functions.
        sqliteStatements: 8,
        postgresStatements: 11,
      },
      {
        version: 107,
        name: "0107_plugin_platform",
        sqliteStatements: 14,
        postgresStatements: 14,
      },
      {
        version: 108,
        name: "0108_customer_marketing",
        // SQLite rebuilds the notification outbox/receipts; PostgreSQL swaps their CHECKs.
        sqliteStatements: 56,
        postgresStatements: 33,
      },
      {
        version: 109,
        name: "0109_inventory_purchasing",
        // PostgreSQL replaces the two ledger semantics functions in place (no DROP TRIGGER).
        sqliteStatements: 58,
        postgresStatements: 56,
      },
      {
        version: 110,
        name: "0110_plugin_providers",
        // SQLite rebuilds plugin_registrations (create, copy, drop, rename, index); PostgreSQL swaps its CHECK.
        sqliteStatements: 22,
        postgresStatements: 18,
      },
      {
        version: 111,
        name: "0111_order_money_chain",
        // Fourteen ADD COLUMNs and two same-currency backfills, the same on both providers.
        sqliteStatements: 17,
        postgresStatements: 17,
      },
      {
        version: 112,
        name: "0112_markets",
        // Three tables, their indexes and guards, orders.market_id, the backup
        // market and its backfills, the checkout authority fence and the
        // generated cache dependency triggers: one statement each on both providers.
        sqliteStatements: 38,
        postgresStatements: 38,
      },
      {
        version: 113,
        name: "0113_country_aware_addresses",
        // The address book and its indexes, ten order snapshot columns, the
        // backfill, the per-country address triggers and the seed, the moved
        // customer addresses, fourteen dropped columns and the re-created
        // event triggers: one statement each on both providers.
        sqliteStatements: 42,
        postgresStatements: 42,
      },
      {
        version: 114,
        name: "0114_shipping_zones",
        // The regions table and its index, the Bangladesh zone from the
        // Everywhere else rates (zone, region, rate move), the renamed pickup
        // document, the zone guard, the checkout authority fence, the
        // generated cache dependency triggers and three agent context
        // columns: one statement each on both providers.
        sqliteStatements: 18,
        postgresStatements: 18,
      },
      {
        version: 115,
        name: "0115_selling_countries_dependency",
        // The generated cache dependency triggers of the countries the
        // active markets sell to and the ledger row: one statement each on both providers.
        sqliteStatements: 6,
        postgresStatements: 6,
      },
      {
        version: 116,
        name: "0116_tax_regions",
        // Tax regions with their guards, fence and generated cache triggers,
        // the Bangladesh regions from today's rates, tax_rates without its
        // jurisdiction columns (rebuilt on SQLite, altered on PostgreSQL),
        // the market's tax flag moved from tax_settings, the store-wide
        // provider and the snapshot columns: one statement each.
        sqliteStatements: 40,
        postgresStatements: 46,
      },
      {
        version: 117,
        name: "0117_phoneless_guest_customers",
        // The guest-phone index rebuilt to skip phoneless records, the
        // phoneless guest-email index and the ledger row.
        sqliteStatements: 4,
        postgresStatements: 4,
      },
      {
        version: 118,
        name: "0118_places",
        // The place directory: places created and filled from
        // delivery_locations, zone places moved onto it (rebuilt on SQLite,
        // the foreign key moved on PostgreSQL) with their triggers, the old
        // table dropped (and its PostgreSQL trigger functions), the indexes,
        // the parent guards, the checkout fence and the generated cache
        // triggers: one statement each.
        sqliteStatements: 28,
        postgresStatements: 31,
      },
      {
        version: 119,
        name: "0119_billing_addresses",
        // Twelve order billing columns, the tax snapshot's address source,
        // the address book's default-billing flag and its index, and the two
        // re-created event triggers (each dropped first) and the ledger: one
        // statement each.
        sqliteStatements: 20,
        postgresStatements: 20,
      },
      {
        version: 120,
        name: "0120_price_lists",
        // Price lists and their prices with their indexes, the market's five
        // pricing columns, the backup-market guards, the checkout fences
        // (the market's re-created on SQLite, its function replaced on
        // PostgreSQL), the generated cache triggers and the ledger: one
        // statement each.
        sqliteStatements: 31,
        postgresStatements: 30,
      },
      {
        version: 121,
        name: "0121_translations",
        // The three tables and their indexes, the store-language backfill
        // (presences, the default from the active checkout copy, the other
        // copies), the language, handle and cleanup guards, the generated
        // cache triggers and the ledger: one statement each.
        sqliteStatements: 69,
        postgresStatements: 69,
      },
      {
        version: 122,
        name: "0122_sales_channels",
        // The three tables and their indexes, the built-in channels, the
        // location links and publication backfill, the feed flag's drop with
        // its reinstalled triggers, the order column, the default location's
        // country, the channel, publication and order guards and fences, the
        // generated event and cache triggers and the ledger: one each.
        sqliteStatements: 57,
        postgresStatements: 57,
      },
      {
        version: 123,
        name: "0123_market_currencies",
        // The market's three currency columns and the as-of backfill, the
        // currency guards, the checkout fence and the market's cache trigger
        // (each re-created on SQLite; the fence's function replaced on
        // PostgreSQL), the four customer spend triggers (re-created on
        // SQLite, their functions replaced on PostgreSQL) and the ledger.
        sqliteStatements: 19,
        postgresStatements: 14,
      },
      {
        version: 124,
        name: "0124_theme_restore_points",
        // The restore point table, its index and the ledger.
        sqliteStatements: 3,
        postgresStatements: 3,
      },
      {
        version: 125,
        name: "0125_plugin_lifecycle",
        // The data-update ledger, six installation columns and the ledger.
        sqliteStatements: 8,
        postgresStatements: 8,
      },
      {
        version: 126,
        name: "0126_plugin_seams",
        // Four tables and their seven indexes, the market column, eight
        // metaobject cache dependency triggers and the ledger.
        sqliteStatements: 21,
        postgresStatements: 21,
      },
      {
        version: 127,
        name: "0127_list_indexes",
        // Twenty-four dashboard list indexes, six replaced ones dropped, the ledger.
        sqliteStatements: 31,
        postgresStatements: 31,
      },
      {
        version: 128,
        name: "0128_scale_reads",
        // Six indexes and the six they replace, the customer_order_stats
        // zero-row backfill and insert trigger, the review FTS table, its
        // rebuild and four triggers (D1 only: Turso and PostgreSQL have no
        // FTS5), the ledger.
        sqliteStatements: 15,
        postgresStatements: 15,
      },
      {
        version: 129,
        name: "0129_order_overview_reads",
        // Six covering/identity indexes and the ledger.
        sqliteStatements: 7,
        postgresStatements: 7,
      },
      {
        version: 130,
        name: "0130_dashboard_home_reads",
        sqliteStatements: 7,
        postgresStatements: 7,
      },
      {
        version: 131,
        name: "0131_analytics_rollup",
        // Four tables, five indexes, four backfills, 28 maintenance triggers and the ledger.
        sqliteStatements: 42,
        postgresStatements: 42,
      },
      {
        version: 132,
        name: "0132_recommendation_buyers",
        sqliteStatements: 3,
        postgresStatements: 3,
      },
      {
        version: 133,
        name: "0133_customer_sale_endpoints",
        sqliteStatements: 15,
        postgresStatements: 15,
      },
      {
        version: 134,
        name: "0134_media_text_index",
        sqliteStatements: 2,
        postgresStatements: 2,
      },
      {
        version: 135,
        name: "0135_inventory_valuation_indexes",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 136,
        name: "0136_buyer_state_covering_index",
        sqliteStatements: 3,
        postgresStatements: 3,
      },
      {
        version: 137,
        name: "0137_recommendation_order_id",
        sqliteStatements: 2,
        postgresStatements: 2,
      },
      {
        version: 138,
        name: "0138_facet_public_counts",
        sqliteStatements: 13,
        postgresStatements: 13,
      },
      {
        version: 139,
        name: "0139_recommendation_order_products",
        sqliteStatements: 18,
        postgresStatements: 18,
      },
      {
        version: 140,
        name: "0140_buyer_public_counts",
        sqliteStatements: 6,
        postgresStatements: 6,
      },
      {
        version: 141,
        name: "0141_conversation_inbox_counts",
        sqliteStatements: 14,
        postgresStatements: 14,
      },
      {
        version: 142,
        name: "0142_staff_alerts",
        sqliteStatements: 7,
        postgresStatements: 7,
      },
      {
        version: 143,
        name: "0143_remaining_polish",
        sqliteStatements: 55,
        postgresStatements: 26,
      },
      {
        version: 144,
        name: "0144_customer_contact_lookup",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 145,
        name: "0145_conversation_search_cursor",
        sqliteStatements: 2,
        postgresStatements: 2,
      },
      {
        version: 146,
        name: "0146_order_write_path",
        sqliteStatements: 75,
        postgresStatements: 75,
      },
      {
        version: 147,
        name: "0147_kv_retirement",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 148,
        name: "0148_queue_retirement",
        sqliteStatements: 13,
        postgresStatements: 13,
      },
      {
        version: 149,
        name: "0149_strict_readers_reset",
        sqliteStatements: 23,
        postgresStatements: 23,
      },
      {
        version: 150,
        name: "0150_facet_engine",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 151,
        name: "0151_postgres_scale",
        sqliteStatements: 2,
        postgresStatements: 12,
      },
      {
        version: 152,
        name: "0152_search_index",
        sqliteStatements: 63,
        postgresStatements: 41,
      },
      {
        version: 153,
        name: "0153_theme_skins",
        sqliteStatements: 17,
        postgresStatements: 17,
      },
      {
        version: 154,
        name: "0154_order_number_sequence",
        sqliteStatements: 2,
        postgresStatements: 4,
      },
      {
        version: 155,
        name: "0155_v2_beta_contract",
        sqliteStatements: 163,
        postgresStatements: 175,
      },
      {
        version: 156,
        name: "0156_custom_field_object_references",
        sqliteStatements: 59,
        postgresStatements: 3,
      },
      {
        version: 157,
        name: "0157_order_search_update_guards",
        sqliteStatements: 1,
        postgresStatements: 1,
      },
      {
        version: 158,
        name: "0158_app_access_contract",
        sqliteStatements: 7,
        postgresStatements: 7,
      },
      {
        version: 159,
        name: "0159_bulk_runs",
        sqliteStatements: 4,
        postgresStatements: 4,
      },
    ]);
  });

  it("keeps the PostgreSQL sidecar DDL identical to the fresh-schema compiler", () => {
    const source = splitSchemaMigrationStatements(readFileSync(
      join(migrationsDirectory, "0050_schema_release_contract.sql"),
      "utf8",
    ));
    const postgres = splitSchemaMigrationStatements(readFileSync(
      join(migrationsDirectory, "postgres/0050_schema_release_contract.sql"),
      "utf8",
    ));

    expect(postgres.slice(0, -1).map((statement) => statement.trim())).toEqual(
      source.slice(0, -1).map((statement) =>
        `${compileSqliteDdlForPostgres(statement).replace(/;\s*$/, "")};`,
      ),
    );
  });

  it("compiles SQLite substring guards into native PostgreSQL expressions", () => {
    expect(compileSqliteDdlForPostgres(
      `CHECK(instr("artifact"."filename", '/') = 0 AND instr("artifact"."filename", char(92)) = 0)`,
    )).toBe(
      `CHECK(position('/' in "artifact"."filename") = 0 AND position(chr(92) in "artifact"."filename") = 0)`,
    );
    expect(compileSqliteDdlForPostgres(
      `CHECK(instr(coalesce("item"."query", ''), '#') = 0)`,
    )).toBe(
      `CHECK(position('#' in coalesce("item"."query", '')) = 0)`,
    );
  });

  it.each([
    "BEGIN;",
    "VACUUM;",
    "PRAGMA foreign_keys = OFF;",
    "CREATE INDEX CONCURRENTLY example_idx ON example (id);",
  ])("rejects transaction-unsafe sidecar SQL: %s", (sql) => {
    expect(() => splitSchemaMigrationStatements(sql)).toThrow(/transaction/i);
  });

  it("installs a fresh store on the Turso engine from 0001 to the current release, exactly the replayed chain", async () => {
    const engine = await connect(":memory:");
    const connection = tursoEngineConnection(engine);
    const artifacts = await loadSchemaUpgradeArtifacts();
    const replayed = await createProviderSchemaDatabase("turso");
    try {
      expect(await inspectTursoSchemaUpgrade(connection, artifacts)).toEqual(EMPTY_SCHEMA_STATE);
      const fresh = await applyTursoSchemaUpgrades(connection, artifacts);
      expect(fresh).toMatchObject({ before: EMPTY_SCHEMA_STATE, after: CURRENT_DATABASE_SCHEMA });
      expect(fresh.applied).toHaveLength(artifacts.length);
      // The same schema objects (the engine re-serializes their SQL), seed rows
      // and ledger as the node:sqlite replay of every migration.
      const catalog = "SELECT type, name, tbl_name AS tableName FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name";
      expect(await engine.prepare(catalog).all()).toEqual(replayed.prepare(catalog).all().map((row) => ({ ...row })));
      // Every seed row (the two builds differ only in their clock times) and the exact ledger.
      const tables = replayed.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
      for (const { name } of tables) {
        const count = `SELECT count(*) AS n FROM "${name}"`;
        expect(Number((await engine.prepare(count).get() as { n: number }).n), name).toBe(Number((replayed.prepare(count).get() as { n: number }).n));
      }
      const ledger = "SELECT version, name, source_sha256 FROM scalius_schema_migrations ORDER BY version";
      expect((await engine.prepare(ledger).all()).map((row) => [(row as { version: number }).version, (row as { source_sha256: string }).source_sha256]))
        .toEqual(replayed.prepare(ledger).all().map((row) => [row.version, row.source_sha256]));
      // Its demand and event triggers run on the engine: no subscriber means
      // no outbox work, then registering a subscriber enables matching facts.
      await engine.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
        VALUES ('ord_no_demand', 'A', '+8801711111111', 'House', 'city', 'zone', 'pending')`);
      expect(await engine.prepare("SELECT topic FROM event_outbox").all()).toEqual([]);
      await engine.exec(`INSERT INTO webhook_subscriptions (id, url, topics, api_version, secret_ciphertext, secret_hint)
        VALUES ('whk_upgrade', 'https://example.test/events', '["order.created"]', '2026-08-01', 'enc:fixture', 'test')`);
      expect(await engine.prepare("SELECT filter FROM event_demand").all()).toEqual([{ filter: "order.created" }]);
      await engine.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
        VALUES ('ord_t', 'A', '+8801711111111', 'House', 'city', 'zone', 'pending')`);
      expect((await engine.prepare("SELECT topic FROM event_outbox").all()).map((row) => (row as { topic: string }).topic)).toEqual(["order.created"]);
      const replay = await applyTursoSchemaUpgrades(connection, artifacts);
      expect(replay).toEqual({ before: CURRENT_DATABASE_SCHEMA, after: CURRENT_DATABASE_SCHEMA, applied: [] });
    } finally {
      replayed.close();
      await engine.close();
    }
  }, 120_000);

  it("upgrades the exact Turso 0049 baseline atomically and is idempotent", async () => {
    const database = createLegacyTursoDatabase();
    const connection = createLocalTursoConnection(database);
    const artifacts = await loadSchemaUpgradeArtifacts();
    try {
      expect(await inspectTursoSchemaUpgrade(connection, artifacts))
        .toMatchObject(DATABASE_SCHEMA_LEGACY_BASELINE);

      const first = await applyTursoSchemaUpgrades(connection, artifacts);
      expect(first.before).toMatchObject(DATABASE_SCHEMA_LEGACY_BASELINE);
      expect(first.after).toEqual(CURRENT_DATABASE_SCHEMA);
      expect(first.applied.map((artifact) => artifact.name))
        .toEqual(artifacts.map((artifact) => artifact.name));
      expect(database.prepare(
        "SELECT version, name, source_sha256 AS sourceSha256 FROM scalius_schema_migrations ORDER BY version",
      ).all()).toEqual(artifacts.map((artifact) => ({
        version: artifact.version,
        name: artifact.name,
        sourceSha256: artifact.sourceSha256,
      })));

      const replay = await applyTursoSchemaUpgrades(connection, artifacts);
      expect(replay.before).toEqual(CURRENT_DATABASE_SCHEMA);
      expect(replay.after).toEqual(CURRENT_DATABASE_SCHEMA);
      expect(replay.applied).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("resumes cleanly when a Turso commit succeeds but its response is lost", async () => {
    const database = createLegacyTursoDatabase();
    const base = createLocalTursoConnection(database);
    let loseFirstResponse = true;
    const connection: TursoSchemaConnection = {
      ...base,
      transactionAsync<T>(callback: Parameters<TursoSchemaConnection["transactionAsync"]>[0]) {
        return {
          async immediate() {
            const result = await base.transactionAsync(callback).immediate();
            if (loseFirstResponse) {
              loseFirstResponse = false;
              throw new Error("simulated response loss after commit");
            }
            return result as T;
          },
        };
      },
    };
    const artifacts = await loadSchemaUpgradeArtifacts();
    try {
      await expect(applyTursoSchemaUpgrades(connection, artifacts))
        .rejects.toThrow(/response loss after commit/i);
      await expect(applyTursoSchemaUpgrades(base, artifacts)).resolves.toMatchObject({
        before: { version: 50, name: "0050_schema_release_contract" },
        after: CURRENT_DATABASE_SCHEMA,
        applied: [
          { version: 51, name: "0051_orders_checkout_write_path" },
          { version: 52, name: "0052_remove_storefront_cache_queue" },
          { version: 53, name: "0053_checkout_language_authority" },
          { version: 54, name: "0054_cache_invalidation_delivery" },
          { version: 55, name: "0055_cache_invalidation_postgres_bigint" },
          { version: 56, name: "0056_agent_access" },
          { version: 57, name: "0057_agent_browser_handoffs" },
          { version: 58, name: "0058_order_shipping_method_snapshot" },
          { version: 59, name: "0059_checkout_delivery_phone_identity" },
          { version: 60, name: "0060_better_auth_account_identity" },
          { version: 61, name: "0061_regular_hex" },
          { version: 62, name: "0062_identity_handoff_audit" },
          { version: 63, name: "0063_media_variants_drop_polar" },
          { version: 64, name: "0064_cache_generation" },
          { version: 65, name: "0065_single_checkout_commit" },
          { version: 66, name: "0066_payment_provider_refs" },
          { version: 67, name: "0067_settings_documents" },
          { version: 68, name: "0068_single_discount_engine" },
          { version: 69, name: "0069_integer_money" },
          { version: 70, name: "0070_order_numbers_timeline" },
          { version: 71, name: "0071_buyer_identity" },
          { version: 72, name: "0072_delivery_zones" },
          { version: 73, name: "0073_combinable_discount_codes" },
          { version: 74, name: "0074_verified_customer_identity" },
          { version: 75, name: "0075_theme_layout_reset" },
          { version: 76, name: "0076_guest_record_links" },
          { version: 77, name: "0077_optioned_product_price" },
          { version: 78, name: "0078_theme_document_v2" },
          { version: 79, name: "0079_guest_record_origin" },
          { version: 80, name: "0080_whole_taka_amounts" },
          { version: 81, name: "0081_theme_document_v3" },
          { version: 82, name: "0082_theme_document_v4" },
          { version: 83, name: "0083_order_line_fulfilment" },
          { version: 84, name: "0084_line_item_properties" },
          { version: 85, name: "0085_conversations" },
          { version: 86, name: "0086_notification_outbox" },
          { version: 87, name: "0087_on_sale_indexes" },
          { version: 88, name: "0088_wave_a_contract" },
          { version: 89, name: "0089_wave_a_contract_columns" },
          { version: 90, name: "0090_catalogue_schema" },
          { version: 91, name: "0091_catalogue_projection_fill" },
          { version: 92, name: "0092_attribute_option_presets" },
          { version: 93, name: "0093_theme_document_v5" },
          { version: 94, name: "0094_media_rendition_ladder" },
          { version: 95, name: "0095_reviews" },
          { version: 96, name: "0096_digital_goods" },
          { version: 97, name: "0097_gift_cards" },
          { version: 98, name: "0098_warranty" },
          { version: 99, name: "0099_customer_whatsapp" },
          { version: 100, name: "0100_cache_dependencies" },
          { version: 101, name: "0101_cache_ordering_dependencies" },
          { version: 102, name: "0102_inventory_locations" },
          { version: 103, name: "0103_order_channel_event_outbox" },
          { version: 104, name: "0104_custom_fields" },
          { version: 105, name: "0105_plugin_runtime" },
          { version: 106, name: "0106_theme_document_v6" },
          { version: 107, name: "0107_plugin_platform" },
          { version: 108, name: "0108_customer_marketing" },
          { version: 109, name: "0109_inventory_purchasing" },
          { version: 110, name: "0110_plugin_providers" },
          { version: 111, name: "0111_order_money_chain" },
          { version: 112, name: "0112_markets" },
          { version: 113, name: "0113_country_aware_addresses" },
          { version: 114, name: "0114_shipping_zones" },
          { version: 115, name: "0115_selling_countries_dependency" },
          { version: 116, name: "0116_tax_regions" },
          { version: 117, name: "0117_phoneless_guest_customers" },
          { version: 118, name: "0118_places" },
          { version: 119, name: "0119_billing_addresses" },
          { version: 120, name: "0120_price_lists" },
          { version: 121, name: "0121_translations" },
          { version: 122, name: "0122_sales_channels" },
          { version: 123, name: "0123_market_currencies" },
          { version: 124, name: "0124_theme_restore_points" },
          { version: 125, name: "0125_plugin_lifecycle" },
          { version: 126, name: "0126_plugin_seams" },
          { version: 127, name: "0127_list_indexes" },
          { version: 128, name: "0128_scale_reads" },
          { version: 129, name: "0129_order_overview_reads" },
          { version: 130, name: "0130_dashboard_home_reads" },
          { version: 131, name: "0131_analytics_rollup" },
          { version: 132, name: "0132_recommendation_buyers" },
          { version: 133, name: "0133_customer_sale_endpoints" },
          { version: 134, name: "0134_media_text_index" },
          { version: 135, name: "0135_inventory_valuation_indexes" },
          { version: 136, name: "0136_buyer_state_covering_index" },
          { version: 137, name: "0137_recommendation_order_id" },
          { version: 138, name: "0138_facet_public_counts" },
          { version: 139, name: "0139_recommendation_order_products" },
          { version: 140, name: "0140_buyer_public_counts" },
          { version: 141, name: "0141_conversation_inbox_counts" },
          { version: 142, name: "0142_staff_alerts" },
          { version: 143, name: "0143_remaining_polish" },
          { version: 144, name: "0144_customer_contact_lookup" },
          { version: 145, name: "0145_conversation_search_cursor" },
          { version: 146, name: "0146_order_write_path" },
          { version: 147, name: "0147_kv_retirement" },
          { version: 148, name: "0148_queue_retirement" },
          { version: 149, name: "0149_strict_readers_reset" },
          { version: 150, name: "0150_facet_engine" },
          { version: 151, name: "0151_postgres_scale" },
          { version: 152, name: "0152_search_index" },
          { version: 153, name: "0153_theme_skins" },
          { version: 154, name: "0154_order_number_sequence" },
          { version: 155, name: "0155_v2_beta_contract" },
          { version: 156, name: "0156_custom_field_object_references" },
          { version: 157, name: "0157_order_search_update_guards" },
          { version: 158, name: "0158_app_access_contract" },
          { version: 159, name: "0159_bulk_runs" },
        ],
      });
    } finally {
      database.close();
    }
  });

  it("refuses a Turso schema change between baseline proof and write-lock acquisition", async () => {
    const database = createLegacyTursoDatabase();
    const base = createLocalTursoConnection(database);
    let injectDrift = true;
    const connection: TursoSchemaConnection = {
      ...base,
      transactionAsync<T>(callback: Parameters<TursoSchemaConnection["transactionAsync"]>[0]) {
        return {
          async immediate() {
            if (injectDrift) {
              injectDrift = false;
              database.exec("CREATE TABLE schema_race (id text PRIMARY KEY)");
            }
            return base.transactionAsync(callback).immediate() as Promise<T>;
          },
        };
      },
    };
    try {
      await expect(applyTursoSchemaUpgrades(
        connection,
        await loadSchemaUpgradeArtifacts(),
      )).rejects.toThrow(/changed before the upgrade lock/i);
      expect(database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'scalius_schema_migrations'",
      ).get()).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("rolls back every Turso statement when a migration fails", async () => {
    const database = createLegacyTursoDatabase();
    const connection = createLocalTursoConnection(database);
    const [artifact] = await loadSchemaUpgradeArtifacts();
    const broken = [{
      ...artifact!,
      sqliteStatements: [
        artifact!.sqliteStatements[0]!,
        "THIS IS NOT VALID SQL",
        ...artifact!.sqliteStatements.slice(1),
      ],
    }];
    try {
      await expect(applyTursoSchemaUpgrades(connection, broken)).rejects.toThrow();
      expect(database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'scalius_schema_migrations'",
      ).get()).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("refuses an unrecognized Turso legacy schema instead of stamping it current", async () => {
    const database = createLegacyTursoDatabase();
    database.exec("CREATE TABLE unexpected_schema_drift (id text PRIMARY KEY);");
    const connection = createLocalTursoConnection(database);
    try {
      await expect(inspectTursoSchemaUpgrade(
        connection,
        await loadSchemaUpgradeArtifacts(),
      )).rejects.toThrow(/does not match the verified 0049/i);
    } finally {
      database.close();
    }
  });

  it.each(["trigger", "index", "constraint"] as const)(
    "detects a missing Turso 0049 %s during semantic baseline proof",
    async (kind) => {
      const database = createLegacyTursoDatabase();
      const connection = createLocalTursoConnection(database);
      try {
        if (kind === "trigger") {
          const row = database.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name LIMIT 1",
          ).get() as { name: string };
          database.exec(`DROP TRIGGER ${quoteSqliteIdentifier(row.name)}`);
        } else if (kind === "index") {
          const row = database.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name LIMIT 1",
          ).get() as { name: string };
          database.exec(`DROP INDEX ${quoteSqliteIdentifier(row.name)}`);
        } else {
          const row = database.prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tax_classes'",
          ).get() as { sql: string };
          const altered = row.sql.replace(
            /,\s*CONSTRAINT "tax_classes_name_length" CHECK\(length\("tax_classes"\."name"\) BETWEEN 1 AND 120\)/,
            "",
          );
          expect(altered).not.toBe(row.sql);
          const dependentSql = database.prepare(`
            SELECT sql FROM sqlite_schema
            WHERE tbl_name = 'tax_classes'
              AND type IN ('index', 'trigger')
              AND sql IS NOT NULL
            ORDER BY type, name
          `).all().map((object) => String(object.sql));
          const replacement = altered
            .replace(
              /^CREATE TABLE [`"]?tax_classes[`"]?/i,
              "CREATE TABLE tax_classes_without_check",
            )
            .replaceAll('"tax_classes".', '"tax_classes_without_check".')
            .replaceAll("`tax_classes`.", "`tax_classes_without_check`.");
          database.exec("PRAGMA foreign_keys = OFF");
          database.exec(replacement);
          database.exec("INSERT INTO tax_classes_without_check SELECT * FROM tax_classes");
          database.exec("DROP TABLE tax_classes");
          database.exec("ALTER TABLE tax_classes_without_check RENAME TO tax_classes");
          for (const sql of dependentSql) database.exec(sql);
          database.exec("PRAGMA foreign_keys = ON");
        }

        await expect(inspectTursoSchemaUpgrade(
          connection,
          await loadSchemaUpgradeArtifacts(),
        )).rejects.toThrow(/does not match the verified 0049/i);
      } finally {
        database.close();
      }
    },
  );

  it("rejects gaps, renamed rows, and future rows in the migration ledger", async () => {
    const artifacts = await loadSchemaUpgradeArtifacts();
    expect(() => validateAppliedSchemaMigrations([
      { version: 51, name: "0051_skipped", sourceSha256: "a".repeat(64) },
    ], artifacts)).toThrow(/diverges at version 50/i);
    expect(() => validateAppliedSchemaMigrations([
      { version: 50, name: "0050_renamed", sourceSha256: artifacts[0]!.sourceSha256 },
    ], artifacts)).toThrow(/diverges at version 50/i);
    expect(() => validateAppliedSchemaMigrations([
      { version: 50, name: artifacts[0]!.name, sourceSha256: "b".repeat(64) },
    ], artifacts)).toThrow(/diverges at version 50/i);
    expect(() => validateAppliedSchemaMigrations([
      ...artifacts.map((artifact) => ({
        version: artifact.version,
        name: artifact.name,
        sourceSha256: artifact.sourceSha256,
      })),
      { version: 62, name: "0062_future", sourceSha256: "c".repeat(64) },
    ], artifacts)).toThrow(/future row/i);
  });

  it("builds a PostgreSQL lock guard that proves the legacy baseline", async () => {
    const [artifact] = await loadSchemaUpgradeArtifacts();
    const guard = buildPostgresSchemaUpgradeGuard(
      artifact!,
      DATABASE_SCHEMA_LEGACY_BASELINE,
    );
    expect(guard).toContain(POSTGRES_MIGRATION_STATE_REGCLASS);
    expect(guard).toContain(postgresMigrationControlTable(POSTGRES_MIGRATION_STATE_TABLE));
    expect(guard).toContain(DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaSha256);
    expect(guard).toContain(POSTGRES_SCHEMA_UPGRADE_ALREADY_APPLIED_CODE);
    expect(guard).toContain(POSTGRES_SCHEMA_UPGRADE_BUSY_CODE);
    expect(guard).toContain("migration_count IS DISTINCT FROM 0");
    expect(guard).toContain("pg_try_advisory_xact_lock");

    const existingControl = buildPostgresMigrationControlSql({
      migrationId: "migration-test",
      version: SQLITE_TO_POSTGRES_CHECKPOINT_VERSION,
      schemaVersion: DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaBundleVersion,
      schemaSha256: DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaSha256,
      sourceSha256: "a".repeat(64),
      sourceBytes: 1,
      databaseContentSha256: "b".repeat(64),
      target: {
        host: "example.neon.tech",
        port: "5432",
        database: "merchant",
        user: "merchant",
      },
    });
    expect(existingControl).toContain(postgresMigrationControlTable(
      POSTGRES_MIGRATION_STATE_TABLE,
    ));
  });

  it("applies PostgreSQL sidecars in one serializable advisory-locked transaction", async () => {
    const artifacts = await loadSchemaUpgradeArtifacts();
    let appliedCount = 0;
    const query = vi.fn((sql: string) => {
      if (sql.includes("to_regclass('public.scalius_schema_migrations')")) {
        return Promise.resolve(postgresResult([[appliedCount > 0 ? "scalius_schema_migrations" : null]]));
      }
      if (sql.includes("SELECT to_regclass($1)")) {
        return Promise.resolve(postgresResult([[POSTGRES_MIGRATION_STATE_REGCLASS]]));
      }
      if (sql.includes(POSTGRES_MIGRATION_STATE_TABLE)) {
        return Promise.resolve(postgresResult([[
          DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaBundleVersion,
          DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaSha256,
          "complete",
        ]]));
      }
      if (sql.includes("FROM scalius_schema_migrations ORDER BY version")) {
        return Promise.resolve(postgresResult(
          artifacts.slice(0, appliedCount).map((artifact) => [
            artifact.version,
            artifact.name,
            artifact.sourceSha256,
          ]),
        ));
      }
      return Promise.resolve(postgresResult([]));
    });
    const transaction = vi.fn(async (queries: PromiseLike<PostgresFullResult>[]) => {
      appliedCount += 1;
      return await Promise.all(queries);
    });
    const connection = { query, transaction } as unknown as PostgresHttpConnection;

    const receipt = await applyPostgresSchemaUpgrades(connection, artifacts);

    expect(receipt.before).toMatchObject(DATABASE_SCHEMA_LEGACY_BASELINE);
    expect(receipt.after).toEqual(CURRENT_DATABASE_SCHEMA);
    expect(receipt.applied.map((artifact) => artifact.name))
      .toEqual(artifacts.map((artifact) => artifact.name));
    expect(transaction).toHaveBeenCalledTimes(artifacts.length);
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Array), {
      arrayMode: true,
      fullResults: true,
      isolationLevel: "Serializable",
      readOnly: false,
    });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("pg_try_advisory_xact_lock"))).toBe(true);
  });

  it("treats a concurrently completed PostgreSQL migration as an idempotent replay", async () => {
    const artifacts = await loadSchemaUpgradeArtifacts();
    let appliedCount = 0;
    const query = vi.fn((sql: string) => {
      if (sql.includes("to_regclass('public.scalius_schema_migrations')")) {
        return Promise.resolve(postgresResult([[appliedCount > 0 ? "scalius_schema_migrations" : null]]));
      }
      if (sql.includes("SELECT to_regclass($1)")) {
        return Promise.resolve(postgresResult([[POSTGRES_MIGRATION_STATE_REGCLASS]]));
      }
      if (sql.includes(POSTGRES_MIGRATION_STATE_TABLE)) {
        return Promise.resolve(postgresResult([[
          DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaBundleVersion,
          DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaSha256,
          "complete",
        ]]));
      }
      if (sql.includes("FROM scalius_schema_migrations ORDER BY version")) {
        return Promise.resolve(postgresResult(
          artifacts.slice(0, appliedCount).map((artifact) => [
            artifact.version,
            artifact.name,
            artifact.sourceSha256,
          ]),
        ));
      }
      return Promise.resolve(postgresResult([]));
    });
    const transaction = vi.fn(async () => {
      appliedCount += 1;
      throw Object.assign(new Error("already applied"), {
        code: POSTGRES_SCHEMA_UPGRADE_ALREADY_APPLIED_CODE,
      });
    });
    const connection = { query, transaction } as unknown as PostgresHttpConnection;

    const receipt = await applyPostgresSchemaUpgrades(connection, artifacts);

    expect(receipt.after).toEqual(CURRENT_DATABASE_SCHEMA);
    expect(receipt.applied).toEqual([]);
    expect(transaction).toHaveBeenCalledTimes(artifacts.length);
  });
});
