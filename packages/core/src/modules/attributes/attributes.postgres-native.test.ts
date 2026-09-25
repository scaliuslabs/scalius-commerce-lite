// PostgreSQL parity for the typed-attribute writes: the typed product writer,
// every type conversion, the value vocabulary (rename, merge, reorder), the
// string value routes, groups and category attribute sets run through the
// fail-closed SQLite profile compiler on a real PostgreSQL server and leave
// the facet projection equal to a rebuild. Opt-in: point
// SCALIUS_TEST_POSTGRES_URL at a disposable server; the test creates and
// drops its own database.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { connectPostgres, createPostgresDatabase } from "@scalius/database/postgres-adapter";
import type { Database } from "@scalius/database/client";

import { convertAttributeValueType } from "./attribute-types";
import { deleteAttributeValueRow, listAttributeValueRows, reorderAttributeValueRows, updateAttributeValueRow } from "./attribute-values";
import { createAttributeGroup, listAttributeGroups, trashAttributeGroup } from "./attribute-groups";
import { getCategoryAttributeSet, replaceCategoryAttributeSet } from "./category-attribute-sets";
import { createAttribute, deleteAttributeValue, listAttributes, listAttributeValues, renameAttributeValue, updateAttribute } from "./attributes.service";
import type { CatalogProjectionRefresh } from "./projection-refresh";
import { catalogProjectionRefreshStatements, rebuildCatalogProjections } from "../products/catalog-projections";
import { createProduct } from "../products/admin/write";
import { createProductSchema } from "../products/validation";

const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();

function canonicalPostgresSchemaSql(): string {
    const databaseDir = fileURLToPath(new URL("../../../../database/", import.meta.url));
    const out = join(mkdtempSync(join(tmpdir(), "scalius-pg-schema-")), "schema.sql");
    const tsx = fileURLToPath(new URL("../../../../../apps/api/node_modules/.bin/tsx", import.meta.url));
    execFileSync(tsx, ["scripts/postgres-schema.ts", "--out", out], { cwd: databaseDir });
    return readFileSync(out, "utf8");
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freshDatabase(): Promise<{ db: Database; client: Client }> {
    const name = `scalius_attributes_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: postgresUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${name}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(canonicalPostgresSchemaSql());
    const db = createPostgresDatabase(url.toString(), { connect: connectPostgres });
    cleanups.push(async () => {
        await client.end();
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
        await admin.end();
    });
    return { db, client };
}

const base = {
    description: "A product for the PostgreSQL attribute parity test.",
    discountType: "percentage" as const,
    discountPercentage: 0,
    discountAmount: 0,
    freeDelivery: false,
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    noIndex: false,
    excludeFromSitemap: false,
    excludeFromProductFeed: false,
    productCondition: "new" as const,
    media: [],
    additionalInfo: [],
    categoryId: "cat_a",
    isActive: true,
    price: 250,
};

describe.runIf(postgresUrl)("typed attributes on PostgreSQL", () => {
    it("writes, converts and renames typed values like D1", async () => {
        const { db, client } = await freshDatabase();
        const refresh: CatalogProjectionRefresh = (ids) => catalogProjectionRefreshStatements(db, ids);
        const facets = async () => JSON.stringify((await client.query(
            "SELECT owner_id, facet_key, value_key, value_label, value_number, sort_order FROM product_facet_values ORDER BY owner_id, facet_key",
        )).rows);
        const expectFacetsFresh = async () => {
            const stored = await facets();
            await rebuildCatalogProjections(db);
            expect(await facets()).toBe(stored);
        };
        const values = async (attributeId: string) => (await client.query(
            "SELECT p.name, v.value, v.value_id, v.value_number FROM product_attribute_values v JOIN products p ON p.id = v.product_id WHERE v.attribute_id = $1 ORDER BY p.name",
            [attributeId],
        )).rows;

        await client.query(`
            INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'Laptops', 'laptops', 'published');
            INSERT INTO categories (id, name, slug, status, parent_id) VALUES ('cat_b', 'Gaming', 'gaming', 'published', 'cat_a');
        `);
        const colour = (await createAttribute(db, { name: "Colour", valueType: "enum", facetDisplay: "swatch", options: ["Red", "Blue"] })).attribute;
        const screen = (await createAttribute(db, { name: "Screen", valueType: "number", unit: "inch" })).attribute;
        const wifi = (await createAttribute(db, { name: "Wi-Fi", valueType: "boolean" })).attribute;
        const material = (await createAttribute(db, { name: "Material", options: ["Aluminium"] })).attribute;
        const ram = (await createAttribute(db, { name: "RAM" })).attribute;

        const one = await createProduct(db, createProductSchema.parse({
            ...base, name: "A laptop",
            attributes: [
                { attributeId: colour.id, value: "red" },
                { attributeId: screen.id, value: "15.60 inch" },
                { attributeId: wifi.id, value: "yes" },
                { attributeId: material.id, value: "Aluminium" },
                { attributeId: ram.id, value: "16" },
            ],
            defaultSku: { sku: "PG-A", trackInventory: true, stock: 2 },
        }));
        await createProduct(db, createProductSchema.parse({
            ...base, name: "B laptop",
            attributes: [{ attributeId: colour.id, value: "Space Grey" }, { attributeId: ram.id, value: "8" }],
            defaultSku: { sku: "PG-B", trackInventory: true, stock: 2 },
        }));
        expect(one.id).toMatch(/^prod_/);
        expect(await values(colour.id)).toEqual([
            expect.objectContaining({ name: "A laptop", value: "Red", value_number: null }),
            expect.objectContaining({ name: "B laptop", value: "Space Grey", value_number: null }),
        ]);
        expect((await values(screen.id))[0]).toMatchObject({ value: "15.6 inch", value_number: 15.6 });
        expect((await values(wifi.id))[0]).toMatchObject({ value: "Yes", value_number: 1 });
        await expectFacetsFresh();

        // Conversions: text -> number -> enum -> boolean refused -> text.
        const preview = await convertAttributeValueType(db, { attributeId: ram.id, valueType: "number", unit: "GB", dryRun: true }, refresh);
        expect(preview).toMatchObject({ rows: 2, unconvertibleCount: 0, changed: false });
        await convertAttributeValueType(db, { attributeId: ram.id, valueType: "number", unit: "GB" }, refresh);
        expect((await values(ram.id)).map((row) => [row.value, row.value_number])).toEqual([["16 GB", 16], ["8 GB", 8]]);
        await expectFacetsFresh();
        await convertAttributeValueType(db, { attributeId: ram.id, valueType: "enum" }, refresh);
        expect((await values(ram.id)).every((row) => row.value_id !== null && row.value_number === null)).toBe(true);
        await expect(convertAttributeValueType(db, { attributeId: ram.id, valueType: "boolean" }, refresh)).rejects.toThrow("do not convert");
        await convertAttributeValueType(db, { attributeId: ram.id, valueType: "text" }, refresh);
        await convertAttributeValueType(db, { attributeId: wifi.id, valueType: "text" }, refresh);
        await convertAttributeValueType(db, { attributeId: wifi.id, valueType: "boolean" }, refresh);
        await expectFacetsFresh();

        // Vocabulary: rename, reorder, merge; string routes.
        const vocabulary = await listAttributeValueRows(db, colour.id);
        const red = vocabulary.values.find((value) => value.value === "Red")!;
        const grey = vocabulary.values.find((value) => value.value === "Space Grey")!;
        expect(red.productCount).toBe(1);
        await updateAttributeValueRow(db, colour.id, red.id, { value: "Crimson", swatchHex: "#AA0000" }, refresh);
        await reorderAttributeValueRows(db, colour.id, [{ valueId: grey.id, sortOrder: 0 }, { valueId: red.id, sortOrder: 9 }], refresh);
        await expectFacetsFresh();
        await deleteAttributeValueRow(db, colour.id, red.id, { mergeIntoValueId: grey.id }, refresh);
        expect((await values(colour.id)).map((row) => row.value)).toEqual(["Space Grey", "Space Grey"]);
        await renameAttributeValue(db, material.id, "aluminium", "Aluminum", refresh);
        expect((await listAttributeValues(db, material.id)).values.map((value) => [value.value, value.isPreset])).toEqual([["Aluminum", true]]);
        await deleteAttributeValue(db, material.id, "Aluminum", refresh);
        await updateAttribute(db, colour.id, { options: ["Space Grey", "Blue", "Green"] }, refresh);
        const listed = await listAttributes(db, { ids: [colour.id] });
        expect(listed.attributes[0]).toMatchObject({ valueType: "enum", facetDisplay: "swatch", options: ["Space Grey", "Blue", "Green"] });
        await expectFacetsFresh();

        // Groups and category sets.
        const group = await createAttributeGroup(db, { name: "Display" });
        await updateAttribute(db, screen.id, { groupId: group.group.id }, refresh);
        expect((await listAttributeGroups(db)).groups).toEqual([expect.objectContaining({ name: "Display", attributeCount: 1 })]);
        await trashAttributeGroup(db, group.group.id);
        await replaceCategoryAttributeSet(db, "cat_a", [{ attributeId: screen.id, sortOrder: 2 }, { attributeId: colour.id, sortOrder: 1 }]);
        await replaceCategoryAttributeSet(db, "cat_b", [{ attributeId: ram.id }, { attributeId: screen.id }]);
        const set = await getCategoryAttributeSet(db, "cat_b");
        expect(set.attributes.map((row) => [row.attributeId, row.orderKey, row.inheritedFromCategoryId])).toEqual([
            [colour.id, 200_001, "cat_a"],
            [screen.id, 200_002, "cat_a"],
            [ram.id, 300_000, null],
        ]);
    });
});
