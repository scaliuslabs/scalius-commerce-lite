// Migration 0092 copies every attribute's JSON `options` presets into its
// normalised value list (attribute_values), the contract step before the
// column is dropped. Applied to a pre-0092 store on D1, Turso and (opt-in)
// PostgreSQL: first position wins among duplicates, existing live values are
// kept, junk is skipped, re-running adds nothing, and the catalogue
// projections are untouched.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, types } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";
import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

const MIGRATION = "0092_attribute_option_presets";
const breakpoint = "--> statement-breakpoint";
const sqliteFile = join(import.meta.dirname, `../migrations/${MIGRATION}.sql`);
const postgresFile = join(import.meta.dirname, `../migrations/postgres/${MIGRATION}.sql`);
const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();

const LONG = "x".repeat(201);
const SEED = `
    INSERT INTO product_attributes (id, name, slug, filterable, options, deleted_at) VALUES
        ('attr_color', 'Color', 'color', 1, '["Red", " Blue ", "red", "", 42, "Green", "${LONG}"]', NULL),
        ('attr_existing', 'Finish', 'finish', 1, '["Matte", "Gloss", "Satin"]', NULL),
        ('attr_trashed', 'Fabric', 'fabric', 1, '["Wool"]', 1700000000),
        ('attr_malformed', 'Broken', 'broken', 1, 'not json', NULL),
        ('attr_object', 'Object', 'object', 1, '{"a": "b"}', NULL),
        ('attr_none', 'None', 'none', 1, NULL, NULL);
    INSERT INTO attribute_values (id, attribute_id, value, normalized_value, sort_order, deleted_at) VALUES
        ('atv_existing01', 'attr_existing', 'MATTE', 'matte', 7, NULL),
        ('atv_trashed001', 'attr_existing', 'Gloss', 'gloss', 3, 1700000000);
    INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('prod_a', 'Shirt', 1000, 'shirt', 1);
    INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('pav_a', 'prod_a', 'attr_color', 'Red');
    INSERT INTO product_facet_values (owner_id, product_id, variant_id, facet_kind, facet_key, value_key, value_label, value_number, sort_order)
        VALUES ('prod_a', 'prod_a', NULL, 'attribute', 'attr_color', 'red', 'Red', NULL, 0);
`;

const VALUES = `SELECT attribute_id, value, normalized_value, sort_order, deleted_at IS NOT NULL AS trashed
    FROM attribute_values ORDER BY attribute_id, deleted_at IS NOT NULL, sort_order, normalized_value`;
const EXPECTED = [
    { attribute_id: "attr_color", value: "Red", normalized_value: "red", sort_order: 0, trashed: 0 },
    { attribute_id: "attr_color", value: "Blue", normalized_value: "blue", sort_order: 1, trashed: 0 },
    { attribute_id: "attr_color", value: "Green", normalized_value: "green", sort_order: 5, trashed: 0 },
    // "Matte" already existed live (its row and order stay); a trashed value is not a live one.
    { attribute_id: "attr_existing", value: "Gloss", normalized_value: "gloss", sort_order: 1, trashed: 0 },
    { attribute_id: "attr_existing", value: "Satin", normalized_value: "satin", sort_order: 2, trashed: 0 },
    { attribute_id: "attr_existing", value: "MATTE", normalized_value: "matte", sort_order: 7, trashed: 0 },
    { attribute_id: "attr_existing", value: "Gloss", normalized_value: "gloss", sort_order: 3, trashed: 1 },
    { attribute_id: "attr_trashed", value: "Wool", normalized_value: "wool", sort_order: 0, trashed: 0 },
];
const PROJECTIONS = "SELECT * FROM product_facet_values ORDER BY owner_id, facet_key";

const dataStatements = (file: string) => readFileSync(file, "utf8").split(breakpoint).slice(0, -1).join("\n");

describe(MIGRATION, () => {
    it.each(["d1", "turso"] as const)("copies the option presets of a pre-0092 %s store once", (provider) => {
        const sqlite = createMigratedSqlite({ provider, beforeMigration: "0092_" });
        sqlite.exec(SEED);
        const projections = sqlite.prepare(PROJECTIONS).all();

        sqlite.exec(compiledMigrationSql(provider, undefined, "0092_"));

        expect(sqlite.prepare(VALUES).all()).toEqual(EXPECTED);
        for (const row of sqlite.prepare("SELECT id FROM attribute_values WHERE id NOT IN ('atv_existing01', 'atv_trashed001')").all()) {
            expect(String(row.id)).toMatch(/^atv_[0-9a-f]{24}$/);
        }
        // Presets are not buyer-visible and nothing references the new rows.
        expect(sqlite.prepare(PROJECTIONS).all()).toEqual(projections);
        expect(sqlite.prepare("SELECT value_id FROM product_attribute_values").all()).toEqual([{ value_id: null }]);
        expect(sqlite.prepare("SELECT version, name FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1").get())
            .toEqual({ version: 92, name: MIGRATION });

        // The next release re-runs the copy before dropping the column: idempotent.
        sqlite.exec(dataStatements(sqliteFile));
        expect(sqlite.prepare(VALUES).all()).toEqual(EXPECTED);
    });
});

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
    for (const close of openClients.splice(0)) await close();
});

describe.runIf(postgresUrl)(`${MIGRATION} on PostgreSQL`, () => {
    it("copies the same presets through the sidecar", async () => {
        const name = `scalius_presets_${randomUUID().replaceAll("-", "")}`;
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
        openClients.push(async () => {
            await client.end();
            await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
            await admin.end();
        });
        await client.query((await compileCanonicalPostgresSchema({ beforeMigration: "0092_" })).sql);
        await client.query(SEED);
        const projections = (await client.query(PROJECTIONS)).rows;

        for (const statement of readFileSync(postgresFile, "utf8").split(breakpoint)) await client.query(statement);
        expect((await client.query("SELECT version, name FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1")).rows)
            .toEqual([{ version: 92, name: MIGRATION }]);
        await client.query(dataStatements(postgresFile));

        // PostgreSQL has no boolean-as-integer: the same columns, trashed as 0/1.
        const rows = (await client.query(VALUES.replace(
            "deleted_at IS NOT NULL AS trashed",
            "CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END AS trashed",
        ))).rows;
        expect(rows).toEqual(EXPECTED);
        expect((await client.query(PROJECTIONS)).rows).toEqual(projections);
    });
});
