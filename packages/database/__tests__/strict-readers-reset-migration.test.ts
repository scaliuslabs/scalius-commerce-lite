import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSqliteMigrationForProvider } from "../src/migration-artifacts";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";
import { strictReadersSeed } from "./strict-readers-reset.fixture";

const name = "0149_strict_readers_reset";
const migration = readFileSync(join(import.meta.dirname, `../migrations/${name}.sql`), "utf8");
const column = (rows: Array<Record<string, unknown>>, key: string) => rows.map((row) => row[key]);

describe("0149 strict readers reset", () => {
  it.each(["d1", "turso"] as const)("resets only what the strict readers reject (%s)", (provider) => {
    const sqlite = createMigratedSqlite({ provider, beforeMigration: "0149_" });
    try {
      sqlite.exec(strictReadersSeed());
      sqlite.exec(compileSqliteMigrationForProvider(migration, provider));
      const all = (sql: string) => sqlite.prepare(sql).all() as Array<Record<string, unknown>>;

      // Theme: a current published document stays; the draft, history row and restore point that are not current go.
      expect(column(all("SELECT revision FROM theme_settings"), "revision")).toEqual([7]);
      expect(all("SELECT id FROM theme_settings_drafts")).toEqual([]);
      expect(column(all("SELECT id FROM theme_settings_versions ORDER BY id"), "id")).toEqual(["themev_ok"]);
      expect(column(all("SELECT id FROM theme_restore_points"), "id")).toEqual(["themerp_good01"]);
      expect(all("SELECT token_hash FROM theme_preview_sessions")).toHaveLength(1);

      // Couriers: the pack's ids, saved tracking pages kept, supplied ones written, keys left to the pack.
      expect(all("SELECT id, provider_type, tracking_url, courier_name FROM delivery_shipments ORDER BY id")).toEqual([
        { id: "shp_app", provider_type: "acme.parcel:parcel", tracking_url: null, courier_name: null },
        { id: "shp_pathao", provider_type: "scalius.bangladesh:pathao", tracking_url: "https://merchant.pathao.com/tracking?consignment_id=DL1001", courier_name: "Pathao" },
        { id: "shp_saved", provider_type: "scalius.bangladesh:pathao", tracking_url: "https://saved.example/DL2", courier_name: "Pathao" },
        { id: "shp_steadfast", provider_type: "scalius.bangladesh:steadfast", tracking_url: "https://steadfast.com.bd/t/SF9", courier_name: "Steadfast" },
      ]);
      expect(all("SELECT id, type, is_active, credentials, config FROM delivery_providers ORDER BY id")).toEqual([
        { id: "dp_app", type: "acme.parcel:parcel", is_active: 1, credentials: "{}", config: "{}" },
        { id: "dp_pathao", type: "scalius.bangladesh:pathao", is_active: 0, credentials: "{}", config: "{}" },
      ]);

      // Payments: the removed id becomes the pack's everywhere it was stored.
      expect(column(all("SELECT payment_method FROM orders ORDER BY id"), "payment_method"))
        .toEqual(["cod", "scalius.bangladesh:sslcommerz", "scalius.bangladesh:sslcommerz"]);
      expect(column(all("SELECT payment_method FROM order_payments"), "payment_method")).toEqual(["scalius.bangladesh:sslcommerz"]);
      expect(column(all("SELECT gateway FROM payment_session_attempts"), "gateway")).toEqual(["scalius.bangladesh:sslcommerz"]);
      expect(JSON.parse(String(all("SELECT value FROM settings WHERE category = 'payment_methods'")[0]!.value)))
        .toEqual({ enabledMethods: ["scalius.bangladesh:sslcommerz", "cod"], defaultMethod: "scalius.bangladesh:sslcommerz" });
      expect(all("SELECT revision FROM settings WHERE category = 'payment_methods'")).toEqual([{ revision: 2 }]);
      expect(all("SELECT id FROM settings WHERE category = 'sslcommerz'")).toEqual([]);
      expect(JSON.parse(String(all("SELECT value FROM settings WHERE category = 'sms'")[0]!.value))).toEqual({ activeProvider: "" });

      // Checkout and the rest.
      expect(column(all("SELECT id FROM checkout_attempts"), "id")).toEqual(["ca_done"]);
      expect(column(all("SELECT id FROM abandoned_checkouts"), "id")).toEqual(["ab_new"]);
      expect(column(all("SELECT id FROM two_factor"), "id")).toEqual(["tf_sealed"]);

      const authority = CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((entry) => entry.version === 149)!;
      expect(all("SELECT name, source_sha256 FROM scalius_schema_migrations WHERE version = 149"))
        .toEqual([{ name, source_sha256: authority.sourceSha256 }]);
    } finally { sqlite.close(); }
  });

  it("clears the theme tables when the published document is not current", () => {
    const sqlite = createMigratedSqlite({ provider: "d1", beforeMigration: "0149_" });
    try {
      sqlite.exec(strictReadersSeed('{"version":6,"template":"marketplace"}'));
      sqlite.exec(migration);
      for (const table of ["theme_settings", "theme_settings_drafts", "theme_settings_versions", "theme_preview_sessions"]) {
        expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
    } finally { sqlite.close(); }
  });

  it("is idempotent: a second run changes nothing", () => {
    const sqlite = createMigratedSqlite({ provider: "d1", beforeMigration: "0149_" });
    try {
      sqlite.exec(strictReadersSeed());
      sqlite.exec(migration);
      const state = () => ["orders", "settings", "delivery_shipments", "delivery_providers", "theme_settings_versions"]
        .map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
      const first = state();
      sqlite.exec(migration.split("--> statement-breakpoint").slice(0, -1).join("\n"));
      expect(state()).toEqual(first);
    } finally { sqlite.close(); }
  });
});
