// The value vocabulary (attribute_values), the string-keyed value routes over
// it, attribute groups and category attribute sets, on the real migrated
// schema. Product-row rewrites are bounded (<= 90 bound parameters per
// statement) and leave the facet projection equal to a rebuild.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";

import {
    createAttributeValueRow,
    deleteAttributeValueRow,
    listAttributeValueRows,
    reorderAttributeValueRows,
    updateAttributeValueRow,
} from "./attribute-values";
import {
    createAttributeGroup,
    listAttributeGroups,
    reorderAttributeGroups,
    trashAttributeGroup,
    updateAttributeGroup,
} from "./attribute-groups";
import { getCategoryAttributeSet, replaceCategoryAttributeSet } from "./category-attribute-sets";
import {
    bulkDeleteAttributes,
    createAttribute,
    deleteAttributeValue,
    listAttributes,
    renameAttributeValue,
    updateAttribute,
} from "./attributes.service";
import type { CatalogProjectionRefresh } from "./projection-refresh";
import { catalogProjectionRefreshStatements, rebuildCatalogProjections } from "../products/catalog-projections";

let sqlite: DatabaseSync;
let db: Database;
let maxParams = 0;

const refresh: CatalogProjectionRefresh = (ids) => catalogProjectionRefreshStatements(db, ids);

beforeEach(() => {
    maxParams = 0;
    ({ sqlite, db } = createSqliteD1Database({
        onQuery: (_query, values) => { maxParams = Math.max(maxParams, values.length); },
    }));
    sqlite.exec("INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'Shirts', 'shirts', 'published');");
});

afterEach(() => sqlite.close());

function seedProducts(count: number): string[] {
    const product = sqlite.prepare(
        "INSERT INTO products (id, name, slug, price_minor, category_id, is_active) VALUES (?, ?, ?, 10000, 'cat_a', 1)",
    );
    const sku = sqlite.prepare(
        "INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES (?, ?, ?, 10000, 5, 1, 1)",
    );
    return Array.from({ length: count }, (_, index) => {
        const id = `prod_${String(index).padStart(4, "0")}`;
        product.run(id, `Product ${index}`, `product-${index}`);
        sku.run(`var_${index}`, id, `SKU-${index}`);
        return id;
    });
}

function seedAttribute(id: string, valueType: "text" | "enum" | "number" | "boolean" = "text") {
    sqlite.prepare("INSERT INTO product_attributes (id, name, slug, value_type, facet_display) VALUES (?, ?, ?, ?, ?)")
        .run(id, `Attribute ${id}`, id.replace(/_/g, "-"), valueType, valueType === "number" ? "range" : "checkbox");
}

function seedValue(id: string, attributeId: string, value: string, sortOrder = 0) {
    sqlite.prepare("INSERT INTO attribute_values (id, attribute_id, value, normalized_value, sort_order) VALUES (?, ?, ?, lower(?), ?)")
        .run(id, attributeId, value, value, sortOrder);
}

function assign(productId: string, attributeId: string, value: string, valueId: string | null = null) {
    sqlite.prepare("INSERT INTO product_attribute_values (id, product_id, attribute_id, value, value_id) VALUES (?, ?, ?, ?, ?)")
        .run(`val_${productId}_${attributeId}`, productId, attributeId, value, valueId);
}

function facetSnapshot() {
    return sqlite.prepare(`
        SELECT owner_id, facet_kind, facet_key, value_key, value_label, value_number, sort_order
        FROM product_facet_values ORDER BY owner_id, facet_key
    `).all();
}

async function expectFacetsFresh() {
    const stored = facetSnapshot();
    await rebuildCatalogProjections(db, { limit: 2_700 });
    expect(stored).toEqual(facetSnapshot());
}

function productValues(attributeId: string) {
    return sqlite.prepare("SELECT value, value_id FROM product_attribute_values WHERE attribute_id = ? ORDER BY product_id")
        .all(attributeId) as Array<{ value: string; value_id: string | null }>;
}

function revisions(): number[] {
    return (sqlite.prepare("SELECT aggregate_revision AS revision FROM products ORDER BY id").all() as Array<{ revision: number }>)
        .map((row) => row.revision);
}

describe("enum value vocabulary", () => {
    let products: string[];
    beforeEach(async () => {
        products = seedProducts(150);
        seedAttribute("attr_colour", "enum");
        seedValue("atv_red_0001", "attr_colour", "Red", 0);
        seedValue("atv_blue_001", "attr_colour", "Blue", 1);
        products.forEach((id, index) => {
            if (index < 120) assign(id, "attr_colour", "Red", "atv_red_0001");
            else assign(id, "attr_colour", "Blue", "atv_blue_001");
        });
        await rebuildCatalogProjections(db);
        maxParams = 0;
    });

    it("lists values in order with product counts", async () => {
        const list = await listAttributeValueRows(db, "attr_colour");
        expect(list.values.map((value) => [value.value, value.productCount])).toEqual([["Red", 120], ["Blue", 30]]);
        expect(list).toMatchObject({ valueType: "enum", total: 2 });
    });

    it("renames a used value across its products in bounded batches and refuses a clash", async () => {
        const result = await updateAttributeValueRow(db, "attr_colour", "atv_red_0001", { value: "Crimson" }, refresh);
        expect(result.productsUpdated).toBe(120);
        expect(productValues("attr_colour").filter((row) => row.value_id === "atv_red_0001").every((row) => row.value === "Crimson")).toBe(true);
        expect(revisions().filter((revision) => revision === 2)).toHaveLength(120);
        expect(maxParams).toBeLessThanOrEqual(90);
        const labels = sqlite.prepare("SELECT DISTINCT value_label FROM product_facet_values WHERE facet_key = 'attr_colour' ORDER BY 1").all();
        expect(labels).toEqual([{ value_label: "Blue" }, { value_label: "Crimson" }]);
        await expectFacetsFresh();

        await expect(updateAttributeValueRow(db, "attr_colour", "atv_red_0001", { value: " blue " }, refresh))
            .rejects.toBeInstanceOf(ConflictError);
    });

    it("refuses deleting a used value unless merged, then repoints and retires it", async () => {
        await expect(deleteAttributeValueRow(db, "attr_colour", "atv_red_0001", {}, refresh))
            .rejects.toThrow("120 products use \"Red\"");
        const merged = await deleteAttributeValueRow(db, "attr_colour", "atv_red_0001", { mergeIntoValueId: "atv_blue_001" }, refresh);
        expect(merged).toEqual({ deleted: true, productsMerged: 120 });
        expect(productValues("attr_colour").every((row) => row.value_id === "atv_blue_001" && row.value === "Blue")).toBe(true);
        const red = sqlite.prepare("SELECT deleted_at FROM attribute_values WHERE id = 'atv_red_0001'").get() as { deleted_at: number | null };
        expect(red.deleted_at).not.toBeNull();
        expect(maxParams).toBeLessThanOrEqual(90);
        await expectFacetsFresh();
        await expect(deleteAttributeValueRow(db, "attr_colour", "atv_blue_001", { mergeIntoValueId: "atv_blue_001" }, refresh))
            .rejects.toBeInstanceOf(ValidationError);
    });

    it("reorders values and refreshes the facet order of their products", async () => {
        const result = await reorderAttributeValueRows(db, "attr_colour", [
            { valueId: "atv_red_0001", sortOrder: 5 },
            { valueId: "atv_blue_001", sortOrder: 1 },
        ], refresh);
        expect(result).toEqual({ updated: 1, productsRefreshed: 120 });
        const orders = sqlite.prepare("SELECT DISTINCT value_key, sort_order FROM product_facet_values WHERE facet_key = 'attr_colour' ORDER BY 1").all();
        expect(orders).toEqual([{ value_key: "atv_blue_001", sort_order: 1 }, { value_key: "atv_red_0001", sort_order: 5 }]);
        expect(revisions().every((revision) => revision === 1)).toBe(true);
        await expectFacetsFresh();
    });

    it("creates values with a lowercase swatch and refuses duplicates", async () => {
        const created = await createAttributeValueRow(db, "attr_colour", { value: "Forest Green", swatchHex: "#1A5C2B" });
        expect(created.value).toMatchObject({ value: "Forest Green", normalizedValue: "forest green", swatchHex: "#1a5c2b", sortOrder: 2 });
        await expect(createAttributeValueRow(db, "attr_colour", { value: " RED " })).rejects.toBeInstanceOf(ConflictError);
    });

    it("renames through the string route by value id and keeps the preset", async () => {
        await renameAttributeValue(db, "attr_colour", "red", "Scarlet", refresh);
        const value = sqlite.prepare("SELECT value, normalized_value FROM attribute_values WHERE id = 'atv_red_0001'").get();
        expect(value).toEqual({ value: "Scarlet", normalized_value: "scarlet" });
        expect(productValues("attr_colour").filter((row) => row.value === "Scarlet")).toHaveLength(120);
        await expectFacetsFresh();
    });

    it("deletes a value from every product through the string route, bounded and refreshed", async () => {
        await deleteAttributeValue(db, "attr_colour", "Red", refresh);
        expect(productValues("attr_colour")).toHaveLength(30);
        expect(maxParams).toBeLessThanOrEqual(90);
        const retired = sqlite.prepare("SELECT deleted_at FROM attribute_values WHERE id = 'atv_red_0001'").get() as { deleted_at: number | null };
        expect(retired.deleted_at).not.toBeNull();
        await expectFacetsFresh();
    });

    it("maps the definition's options onto the vocabulary and refuses removing a used enum value", async () => {
        await expect(updateAttribute(db, "attr_colour", { options: ["Blue"] }, refresh)).rejects.toThrow("Products still use \"Red\"");
        await updateAttribute(db, "attr_colour", { options: ["Blue", "Red", "White"] }, refresh);
        const { attributes } = await listAttributes(db, { ids: ["attr_colour"] });
        expect(attributes[0]).toMatchObject({ options: ["Blue", "Red", "White"], valueType: "enum", facetDisplay: "checkbox" });
        // Reordering enum values re-sorts the facet rows.
        await expectFacetsFresh();
    });
});

describe("text presets and string value routes", () => {
    it("renames text across more than 90 products with their refresh and revision bump", async () => {
        const products = seedProducts(120);
        seedAttribute("attr_material");
        products.forEach((id, index) => assign(id, "attr_material", index % 2 ? " cotton" : "Linen"));
        await rebuildCatalogProjections(db);
        maxParams = 0;

        await renameAttributeValue(db, "attr_material", "Cotton", "Organic cotton", refresh);

        expect(productValues("attr_material").filter((row) => row.value === "Organic cotton")).toHaveLength(60);
        expect(revisions().filter((revision) => revision === 2)).toHaveLength(60);
        expect(maxParams).toBeLessThanOrEqual(90);
        await expectFacetsFresh();

        await deleteAttributeValue(db, "attr_material", "linen", refresh);
        expect(productValues("attr_material")).toHaveLength(60);
        await expectFacetsFresh();
    });

    it("stores presets as attribute_values and never touches the options column", async () => {
        const { attribute } = await createAttribute(db, { name: "Fabric", options: ["Silk", "Wool", "silk"] });
        const rows = sqlite.prepare("SELECT value, sort_order FROM attribute_values WHERE attribute_id = ? AND deleted_at IS NULL ORDER BY sort_order")
            .all(attribute.id);
        expect(rows).toEqual([{ value: "Silk", sort_order: 0 }, { value: "Wool", sort_order: 1 }]);
        const column = sqlite.prepare("SELECT options FROM product_attributes WHERE id = ?").get(attribute.id) as { options: string | null };
        expect(column.options).toBeNull();

        await updateAttribute(db, attribute.id, { options: ["Wool", "Cashmere"] }, refresh);
        const { attributes } = await listAttributes(db, { ids: [attribute.id] });
        expect(attributes[0]!.options).toEqual(["Wool", "Cashmere"]);
    });

    it("refuses presets on number and yes/no attributes and a unit on text", async () => {
        await expect(createAttribute(db, { name: "Weight", valueType: "number", options: ["1"] })).rejects.toBeInstanceOf(ValidationError);
        await expect(createAttribute(db, { name: "Material", unit: "kg" })).rejects.toBeInstanceOf(ValidationError);
        await expect(createAttribute(db, { name: "Swatchy", facetDisplay: "swatch" })).rejects.toBeInstanceOf(ValidationError);
        const number = await createAttribute(db, { name: "Screen size", valueType: "number", unit: "inch" });
        expect(number.attribute).toMatchObject({ valueType: "number", unit: "inch", facetDisplay: "range" });
        seedAttribute("attr_flag", "boolean");
        await expect(createAttributeValueRow(db, "attr_flag", { value: "Yes" })).rejects.toBeInstanceOf(ValidationError);
        await expect(updateAttribute(db, number.attribute.id, { facetDisplay: "swatch" }, refresh)).rejects.toBeInstanceOf(ValidationError);
    });

    it("keeps listing query keys out of attribute slugs", async () => {
        const derived = await createAttribute(db, { name: "Brand" });
        expect(derived.attribute.slug).toBe("brand-2");
        await expect(createAttribute(db, { name: "Sorting", slug: "sort" })).rejects.toBeInstanceOf(ValidationError);
        await expect(updateAttribute(db, derived.attribute.id, { slug: "page" }, refresh)).rejects.toBeInstanceOf(ValidationError);
    });

    it("permanently deletes an attribute with its vocabulary and facet rows", async () => {
        seedAttribute("attr_old", "enum");
        seedValue("atv_old_0001", "attr_old", "Old");
        sqlite.exec("UPDATE product_attributes SET deleted_at = 1 WHERE id = 'attr_old'");
        await bulkDeleteAttributes(db, ["attr_old"], true);
        expect(sqlite.prepare("SELECT count(*) AS n FROM attribute_values WHERE attribute_id = 'attr_old'").get()).toEqual({ n: 0 });
        expect(sqlite.prepare("SELECT count(*) AS n FROM product_attributes WHERE id = 'attr_old'").get()).toEqual({ n: 0 });
    });
});

describe("attribute groups", () => {
    it("creates, renames, reorders and trashes groups; trashing ungroups its attributes", async () => {
        const display = await createAttributeGroup(db, { name: "Display" });
        const cpu = await createAttributeGroup(db, { name: "Processor" });
        await expect(createAttributeGroup(db, { name: " display " })).rejects.toBeInstanceOf(ConflictError);
        const { attribute } = await createAttribute(db, { name: "Panel", groupId: display.group.id });
        await expect(createAttribute(db, { name: "Other", groupId: "atg_missing01" })).rejects.toBeInstanceOf(ValidationError);

        await reorderAttributeGroups(db, [{ groupId: cpu.group.id, sortOrder: 0 }, { groupId: display.group.id, sortOrder: 1 }]);
        let list = await listAttributeGroups(db);
        expect(list.groups.map((group) => [group.name, group.attributeCount])).toEqual([["Processor", 0], ["Display", 1]]);

        await expect(updateAttributeGroup(db, cpu.group.id, { name: "DISPLAY" })).rejects.toBeInstanceOf(ConflictError);
        await updateAttributeGroup(db, cpu.group.id, { name: "CPU" });

        await trashAttributeGroup(db, display.group.id);
        const grouped = sqlite.prepare("SELECT group_id FROM product_attributes WHERE id = ?").get(attribute.id);
        expect(grouped).toEqual({ group_id: null });
        list = await listAttributeGroups(db);
        expect(list.groups.map((group) => group.name)).toEqual(["CPU"]);
        await expect(createAttributeGroup(db, { name: "Display" })).resolves.toBeDefined();
        await expect(trashAttributeGroup(db, display.group.id)).rejects.toBeInstanceOf(NotFoundError);
    });
});

describe("category attribute sets", () => {
    beforeEach(() => {
        sqlite.exec(`
            INSERT INTO categories (id, name, slug, status) VALUES ('cat_root', 'Electronics', 'electronics', 'published');
            INSERT INTO categories (id, name, slug, status, parent_id) VALUES ('cat_mid', 'Computers', 'computers', 'published', 'cat_root');
            INSERT INTO categories (id, name, slug, status, parent_id) VALUES ('cat_leaf', 'Laptops', 'laptops', 'published', 'cat_mid');
        `);
        for (const id of ["attr_x", "attr_y", "attr_z", "attr_w", "attr_v", "attr_gone"]) seedAttribute(id);
        sqlite.exec("UPDATE product_attributes SET deleted_at = 1 WHERE id = 'attr_gone'");
    });

    it("inherits every ancestor's set, root-most first, the smallest key per attribute winning", async () => {
        await replaceCategoryAttributeSet(db, "cat_root", [{ attributeId: "attr_x", sortOrder: 5 }, { attributeId: "attr_y", sortOrder: 1 }]);
        await replaceCategoryAttributeSet(db, "cat_mid", [{ attributeId: "attr_z", sortOrder: 0 }, { attributeId: "attr_x", sortOrder: 0 }]);
        maxParams = 0;
        const leaf = await replaceCategoryAttributeSet(db, "cat_leaf", [
            { attributeId: "attr_w", sortOrder: 0 },
            { attributeId: "attr_v", sortOrder: 0 },
        ]);
        expect(maxParams).toBeLessThanOrEqual(90);

        // attr_x: the root's 100005 beats the parent's 200000. Equal keys tie by name (v before w).
        expect(leaf.attributes.map((row) => [row.attributeId, row.orderKey, row.inheritedFromCategoryId])).toEqual([
            ["attr_y", 100_001, "cat_root"],
            ["attr_x", 100_005, "cat_root"],
            ["attr_z", 200_000, "cat_mid"],
            ["attr_v", 300_000, null],
            ["attr_w", 300_000, null],
        ]);
        const mid = await getCategoryAttributeSet(db, "cat_mid");
        expect(mid.attributes.map((row) => [row.attributeId, row.orderKey])).toEqual([
            ["attr_y", 200_001],
            ["attr_x", 200_005],
            ["attr_z", 300_000],
        ]);
    });

    it("refuses trashed attributes and categories and keeps the own set replaceable", async () => {
        await expect(replaceCategoryAttributeSet(db, "cat_leaf", [{ attributeId: "attr_gone" }])).rejects.toBeInstanceOf(ValidationError);
        await expect(replaceCategoryAttributeSet(db, "cat_missing", [])).rejects.toBeInstanceOf(NotFoundError);
        sqlite.exec("UPDATE categories SET deleted_at = 1 WHERE id = 'cat_a'");
        await expect(replaceCategoryAttributeSet(db, "cat_a", [])).rejects.toBeInstanceOf(ConflictError);

        await replaceCategoryAttributeSet(db, "cat_leaf", [{ attributeId: "attr_w" }]);
        const cleared = await replaceCategoryAttributeSet(db, "cat_leaf", []);
        expect(cleared.attributes).toEqual([]);
    });
});
