// Type conversion and the typed product writer on the real migrated schema:
// every type pair converts (or is refused before anything changes), an
// interrupted conversion resumes, every statement stays within 90 bound
// parameters, and after each write the stored facet projection equals a
// rebuild from scratch.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ATTRIBUTE_VALUE_TYPES, type AttributeValueType } from "@scalius/shared/catalog-attributes";
import { ValidationError } from "@scalius/core/errors";

import { convertAttributeValueType } from "./attribute-types";
import { prepareProductAttributeValueRows } from "./product-attribute-values";
import type { CatalogProjectionRefresh } from "./projection-refresh";
import { catalogProjectionRefreshStatements, rebuildCatalogProjections } from "../products/catalog-projections";
import { createProduct, updateProduct } from "../products/admin/write";
import { getProductDetails } from "../products/admin/read";
import { createProductSchema, updateProductSchema } from "../products/validation";

let sqlite: DatabaseSync;
let db: Database;
let maxParams = 0;
let failBatch: number | null = null;
let batchCount = 0;

const refresh: CatalogProjectionRefresh = (ids) => catalogProjectionRefreshStatements(db, ids);

beforeEach(() => {
    maxParams = 0;
    failBatch = null;
    batchCount = 0;
    ({ sqlite, db } = createSqliteD1Database({
        onQuery: (_query, values) => { maxParams = Math.max(maxParams, values.length); },
        beforeBatch: () => {
            batchCount += 1;
            if (failBatch !== null && batchCount === failBatch) throw new Error("simulated interruption");
        },
    }));
    sqlite.exec(`
        INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'Laptops', 'laptops', 'published');
    `);
});

afterEach(() => sqlite.close());

function seedProducts(count: number, prefix = "p"): string[] {
    const ids: string[] = [];
    const product = sqlite.prepare(
        "INSERT INTO products (id, name, slug, price_minor, category_id, is_active) VALUES (?, ?, ?, 10000, 'cat_a', 1)",
    );
    const sku = sqlite.prepare(
        "INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES (?, ?, ?, 10000, 5, 1, 1)",
    );
    for (let index = 0; index < count; index += 1) {
        const id = `prod_${prefix}${String(index).padStart(4, "0")}`;
        product.run(id, `Product ${prefix}${index}`, `product-${prefix}-${index}`);
        sku.run(`var_${prefix}${index}`, id, `SKU-${prefix}-${index}`);
        ids.push(id);
    }
    return ids;
}

function seedAttribute(id: string, valueType: AttributeValueType = "text", unit: string | null = null) {
    const facet = valueType === "number" ? "range" : "checkbox";
    sqlite.prepare(
        "INSERT INTO product_attributes (id, name, slug, value_type, unit, facet_display) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, `Attribute ${id}`, id.replace(/_/g, "-"), valueType, unit, facet);
}

function assignText(attributeId: string, values: Array<[productId: string, value: string]>) {
    const insert = sqlite.prepare(
        "INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES (?, ?, ?, ?)",
    );
    for (const [productId, value] of values) insert.run(`val_${productId}_${attributeId}`, productId, attributeId, value);
}

type Row = { product_id: string; value: string; value_id: string | null; value_number: number | null };
function rows(attributeId: string): Row[] {
    return sqlite.prepare(
        "SELECT product_id, value, value_id, value_number FROM product_attribute_values WHERE attribute_id = ? ORDER BY product_id",
    ).all(attributeId) as Row[];
}

function definition(attributeId: string) {
    return sqlite.prepare("SELECT value_type AS valueType, unit, facet_display AS facetDisplay FROM product_attributes WHERE id = ?")
        .get(attributeId) as { valueType: string; unit: string | null; facetDisplay: string };
}

function facetSnapshot() {
    return sqlite.prepare(`
        SELECT owner_id, product_id, variant_id, facet_kind, facet_key, value_key, value_label, value_number, sort_order
        FROM product_facet_values ORDER BY owner_id, facet_key
    `).all();
}

/** The stored facet rows equal what a rebuild from the sources writes. */
async function expectFacetsFresh() {
    const stored = facetSnapshot();
    await rebuildCatalogProjections(db, { limit: 2_700 });
    expect(stored).toEqual(facetSnapshot());
}

function inTargetShape(type: AttributeValueType, row: Row): boolean {
    switch (type) {
        case "text": return row.value_id === null && row.value_number === null;
        case "enum": return row.value_id !== null && row.value_number === null;
        case "number": return row.value_id === null && row.value_number !== null;
        case "boolean": return row.value_id === null && (row.value_number === 0 || row.value_number === 1)
            && (row.value === "Yes" || row.value === "No");
    }
}

describe("convertAttributeValueType", () => {
    it("converts text to number with an optional trailing unit and refreshes the facets", async () => {
        const products = seedProducts(3);
        seedAttribute("attr_screen");
        assignText("attr_screen", [[products[0]!, "15.6 inch"], [products[1]!, "13.30"], [products[2]!, "14INCH"]]);
        await rebuildCatalogProjections(db);
        maxParams = 0;

        const result = await convertAttributeValueType(db, { attributeId: "attr_screen", valueType: "number", unit: "inch" }, refresh);

        // A checkbox filter still suits numbers, so it is kept (the default applies only when it no longer fits).
        expect(result).toMatchObject({ fromType: "text", valueType: "number", unit: "inch", facetDisplay: "checkbox", converted: 3, skipped: 0, changed: true });
        expect(rows("attr_screen").map((row) => [row.value, row.value_number])).toEqual([
            ["15.6 inch", 15.6], ["13.3 inch", 13.3], ["14 inch", 14],
        ]);
        expect(definition("attr_screen")).toEqual({ valueType: "number", unit: "inch", facetDisplay: "checkbox" });
        expect(maxParams).toBeLessThanOrEqual(90);
        const facets = sqlite.prepare("SELECT value_key, value_number FROM product_facet_values WHERE facet_key = 'attr_screen' ORDER BY value_number").all();
        expect(facets).toEqual([
            { value_key: "13.3", value_number: 13.3 },
            { value_key: "14", value_number: 14 },
            { value_key: "15.6", value_number: 15.6 },
        ]);
        await expectFacetsFresh();
    });

    it("refuses the whole conversion with samples before changing anything, and previews it as a dry run", async () => {
        const products = seedProducts(3);
        seedAttribute("attr_ram");
        assignText("attr_ram", [[products[0]!, "8"], [products[1]!, "sixteen"], [products[2]!, "32 GB"]]);
        const before = rows("attr_ram");

        const preview = await convertAttributeValueType(db, { attributeId: "attr_ram", valueType: "number", dryRun: true }, refresh);
        expect(preview).toMatchObject({ dryRun: true, rows: 3, distinctValues: 3, unconvertibleCount: 2, changed: false });
        expect(preview.unconvertibleSamples.sort()).toEqual(["32 GB", "sixteen"]);

        const error = await convertAttributeValueType(db, { attributeId: "attr_ram", valueType: "number" }, refresh).catch((caught) => caught);
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.message).toContain("2 values do not convert to number");
        expect(definition("attr_ram").valueType).toBe("text");
        expect(rows("attr_ram")).toEqual(before);

        // With the unit the same values convert.
        const withUnit = await convertAttributeValueType(db, { attributeId: "attr_ram", valueType: "number", unit: "GB", dryRun: true }, refresh);
        expect(withUnit.unconvertibleSamples).toEqual(["sixteen"]);
    });

    it("converts text to enum: one value per normalised text, display from the value", async () => {
        const products = seedProducts(4);
        seedAttribute("attr_colour");
        assignText("attr_colour", [[products[0]!, "Red"], [products[1]!, "red"], [products[2]!, "Blue"], [products[3]!, "RED"]]);
        await rebuildCatalogProjections(db);

        const result = await convertAttributeValueType(db, { attributeId: "attr_colour", valueType: "enum", facetDisplay: "swatch" }, refresh);

        expect(result).toMatchObject({ newValues: 2, converted: 4, facetDisplay: "swatch" });
        const values = sqlite.prepare("SELECT id, value FROM attribute_values WHERE attribute_id = 'attr_colour' AND deleted_at IS NULL ORDER BY sort_order").all() as Array<{ id: string; value: string }>;
        expect(values.map((value) => value.value)).toEqual(["Blue", "RED"]);
        const red = values.find((value) => value.value === "RED")!;
        expect(rows("attr_colour").map((row) => [row.value, row.value_id])).toEqual([
            ["RED", red.id], ["RED", red.id], ["Blue", values[0]!.id], ["RED", red.id],
        ]);
        await expectFacetsFresh();
    });

    it("converts text to yes/no, including Bangla", async () => {
        const products = seedProducts(4);
        seedAttribute("attr_wifi");
        assignText("attr_wifi", [[products[0]!, "yes"], [products[1]!, "No"], [products[2]!, "হ্যাঁ"], [products[3]!, "0"]]);

        await convertAttributeValueType(db, { attributeId: "attr_wifi", valueType: "boolean" }, refresh);

        expect(rows("attr_wifi").map((row) => [row.value, row.value_number])).toEqual([
            ["Yes", 1], ["No", 0], ["Yes", 1], ["No", 0],
        ]);
        await expectFacetsFresh();
    });

    const pairs = ATTRIBUTE_VALUE_TYPES.flatMap((from) => ATTRIBUTE_VALUE_TYPES.map((to) => [from, to] as const));
    it.each(pairs)("converts %s to %s or refuses it untouched", async (from, to) => {
        const products = seedProducts(6);
        seedAttribute("attr_pair");
        assignText("attr_pair", products.map((id, index) => [id, index % 2 === 0 ? "1" : "0"]));
        await convertAttributeValueType(db, { attributeId: "attr_pair", valueType: from }, refresh);
        expect(rows("attr_pair").every((row) => inTargetShape(from, row))).toBe(true);
        await rebuildCatalogProjections(db);
        const before = rows("attr_pair");
        maxParams = 0;

        const outcome = await convertAttributeValueType(db, { attributeId: "attr_pair", valueType: to }, refresh)
            .catch((error: unknown) => error);

        expect(maxParams).toBeLessThanOrEqual(90);
        if (outcome instanceof ValidationError) {
            // Yes/No text does not read as a number: refused before any write.
            expect([from, to]).toEqual(["boolean", "number"]);
            expect(definition("attr_pair").valueType).toBe(from);
            expect(rows("attr_pair")).toEqual(before);
        } else {
            expect(outcome).not.toBeInstanceOf(Error);
            expect(definition("attr_pair").valueType).toBe(to);
            expect(rows("attr_pair").every((row) => inTargetShape(to, row))).toBe(true);
            if (to === "number" || to === "boolean") {
                const live = sqlite.prepare("SELECT count(*) AS n FROM attribute_values WHERE attribute_id = 'attr_pair' AND deleted_at IS NULL").get() as { n: number };
                expect(live.n).toBe(0);
            }
        }
        await expectFacetsFresh();
    });

    it("resumes an interrupted conversion and stays within 90 bound parameters per statement", async () => {
        const products = seedProducts(200);
        seedAttribute("attr_weight");
        assignText("attr_weight", products.map((id, index) => [id, `${(index % 7) + 1}.5 kg`]));
        await rebuildCatalogProjections(db);
        maxParams = 0;
        batchCount = 0;
        // Batch 1 switches the type, batch 2 converts 90 products, batch 3 fails.
        failBatch = 3;

        await expect(convertAttributeValueType(db, { attributeId: "attr_weight", valueType: "number", unit: "kg" }, refresh))
            .rejects.toThrow("simulated interruption");
        expect(definition("attr_weight").valueType).toBe("number");
        const partial = rows("attr_weight");
        expect(partial.filter((row) => row.value_number !== null)).toHaveLength(90);
        // Half-converted: the facet holds exactly the converted products, in the new shape.
        const midway = sqlite.prepare("SELECT value_key, value_number FROM product_facet_values WHERE facet_key = 'attr_weight'").all() as Array<{ value_key: string; value_number: number | null }>;
        expect(midway).toHaveLength(90);
        expect(midway.every((row) => row.value_number !== null && row.value_key === String(row.value_number))).toBe(true);

        failBatch = null;
        const resumed = await convertAttributeValueType(db, { attributeId: "attr_weight", valueType: "number", unit: "kg" }, refresh);
        expect(resumed).toMatchObject({ rows: 110, converted: 110, skipped: 0 });
        expect(rows("attr_weight").every((row) => row.value_number !== null && row.value === `${row.value_number} kg`)).toBe(true);
        expect(maxParams).toBeLessThanOrEqual(90);
        const revisions = sqlite.prepare("SELECT DISTINCT aggregate_revision AS revision FROM products").all();
        expect(revisions).toEqual([{ revision: 2 }]);
        await expectFacetsFresh();

        const again = await convertAttributeValueType(db, { attributeId: "attr_weight", valueType: "number", unit: "kg" }, refresh);
        expect(again).toMatchObject({ rows: 0, converted: 0, changed: false });
    });

    it("refuses an enum conversion of more than 2,000 distinct values", async () => {
        const products = seedProducts(2_001);
        seedAttribute("attr_serial");
        assignText("attr_serial", products.map((id, index) => [id, `S${index}`]));
        await expect(convertAttributeValueType(db, { attributeId: "attr_serial", valueType: "enum" }, refresh))
            .rejects.toThrow("at most 2,000 values");
        expect(definition("attr_serial").valueType).toBe("text");
    });
});

const baseProduct = {
    description: "Typed attribute writer test.",
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
    price: 500,
};

describe("prepareProductAttributeValueRows", () => {
    beforeEach(() => {
        seedAttribute("attr_material");
        seedAttribute("attr_colour", "enum");
        seedAttribute("attr_screen", "number", "inch");
        seedAttribute("attr_wifi", "boolean");
        seedAttribute("attr_gone");
        sqlite.exec(`
            UPDATE product_attributes SET deleted_at = 1 WHERE id = 'attr_gone';
            INSERT INTO attribute_values (id, attribute_id, value, normalized_value, sort_order)
            VALUES ('atv_red_000', 'attr_colour', 'Red', 'red', 0);
        `);
    });

    it("writes one typed row per assignment that the type triggers accept, creating an unknown enum value once", async () => {
        maxParams = 0;
        const first = await createProduct(db, createProductSchema.parse({
            ...baseProduct,
            name: "Laptop one",
            attributes: [
                { attributeId: "attr_material", value: "  Aluminium " },
                { attributeId: "attr_colour", value: "red" },
                { attributeId: "attr_screen", value: "15.60 inch" },
                { attributeId: "attr_wifi", value: "YES" },
            ],
        }));
        const second = await createProduct(db, createProductSchema.parse({
            ...baseProduct,
            name: "Laptop two",
            attributes: [{ attributeId: "attr_colour", value: "Space Grey" }],
        }));
        const third = await createProduct(db, createProductSchema.parse({
            ...baseProduct,
            name: "Laptop three",
            attributes: [{ attributeId: "attr_colour", value: "space grey" }],
        }));

        const stored = sqlite.prepare(`
            SELECT product_id, attribute_id, value, value_id, value_number FROM product_attribute_values ORDER BY product_id, attribute_id
        `).all() as Array<{ product_id: string; attribute_id: string; value: string; value_id: string | null; value_number: number | null }>;
        const firstRows = Object.fromEntries(stored.filter((row) => row.product_id === first.id).map((row) => [row.attribute_id, row]));
        expect(firstRows.attr_material).toMatchObject({ value: "Aluminium", value_id: null, value_number: null });
        expect(firstRows.attr_colour).toMatchObject({ value: "Red", value_id: "atv_red_000", value_number: null });
        expect(firstRows.attr_screen).toMatchObject({ value: "15.6 inch", value_id: null, value_number: 15.6 });
        expect(firstRows.attr_wifi).toMatchObject({ value: "Yes", value_number: 1 });
        const grey = sqlite.prepare("SELECT id, value FROM attribute_values WHERE normalized_value = 'space grey'").all() as Array<{ id: string; value: string }>;
        expect(grey).toHaveLength(1);
        const greyRows = stored.filter((row) => row.product_id === second.id || row.product_id === third.id);
        expect(greyRows.map((row) => [row.value, row.value_id])).toEqual([["Space Grey", grey[0]!.id], ["Space Grey", grey[0]!.id]]);
        await expectFacetsFresh();

        // The editor round-trips what it read back.
        const details = (await getProductDetails(db, first.id))!;
        await updateProduct(db, first.id, updateProductSchema.parse({
            ...baseProduct,
            id: first.id,
            name: details.name,
            slug: details.slug,
            expectedAggregateRevision: details.aggregateRevision,
            attributes: details.attributes.map((attribute: { attributeId: string; value: string }) => ({
                attributeId: attribute.attributeId,
                value: attribute.value,
            })),
        }));
        const after = sqlite.prepare("SELECT attribute_id, value, value_id, value_number FROM product_attribute_values WHERE product_id = ? ORDER BY attribute_id")
            .all(first.id);
        expect(after).toEqual(Object.values(firstRows).map(({ product_id: _product, ...row }) => row));
        await expectFacetsFresh();
    });

    it("refuses a value that does not fit the type, naming the field", async () => {
        const productId = seedProducts(1)[0]!;
        const error = await prepareProductAttributeValueRows(db, productId, [
            { attributeId: "attr_material", value: "Steel" },
            { attributeId: "attr_screen", value: "big" },
        ]).catch((caught) => caught);
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.details).toEqual({ field: "attributes.1.value" });

        await expect(prepareProductAttributeValueRows(db, productId, [{ attributeId: "attr_wifi", value: "maybe" }]))
            .rejects.toThrow("is not yes or no");
        await expect(prepareProductAttributeValueRows(db, productId, [{ attributeId: "attr_gone", value: "x" }]))
            .rejects.toThrow("unavailable or in trash");
        await expect(prepareProductAttributeValueRows(db, productId, [{ attributeId: "attr_missing", value: "x" }]))
            .rejects.toThrow("unavailable or in trash");
    });

    it("keeps 90 assignments within the parameter bound", async () => {
        const productId = seedProducts(1)[0]!;
        for (let index = 0; index < 90; index += 1) seedAttribute(`attr_bulk_${index}`, index % 2 === 0 ? "enum" : "text");
        const { statements } = await prepareProductAttributeValueRows(db, productId, Array.from({ length: 90 }, (_, index) => ({
            attributeId: `attr_bulk_${index}`,
            value: `Value ${index}`,
        })));
        maxParams = 0;
        await db.batch([...statements, ...refresh([productId])] as never);
        expect(maxParams).toBeLessThanOrEqual(90);
        const count = sqlite.prepare("SELECT count(*) AS n FROM product_attribute_values WHERE product_id = ?").get(productId) as { n: number };
        expect(count.n).toBe(90);
        await expectFacetsFresh();
    });
});
