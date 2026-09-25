import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it, vi } from "vitest";

import { ValidationError } from "@scalius/core/errors";
import { createProduct, duplicateProduct, updateProduct } from "./write";
import { getProductDetails } from "./read";
import { createProductSchema, updateProductSchema } from "../validation";
import { createVariant, updateVariant } from "../variants";
import { saveProductOptionMatrix } from "../option-matrix";

vi.mock("../../inventory/alerts", () => ({ checkAndAlertLowStock: vi.fn() }));

const baseInput = {
    name: "Engraved mug",
    description: null,
    price: 500,
    categoryId: null,
    isActive: true,
    discountType: "percentage" as const,
    discountPercentage: 0,
    discountAmount: 0,
    freeDelivery: false,
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    productCondition: "new" as const,
    slug: "engraved-mug",
    media: [],
    attributes: [],
    additionalInfo: [],
};

const buyerInputs = {
    fields: [
        { key: "engraving", label: "Engraving text", type: "text" as const, maxLength: 30, price: 200 },
        {
            key: "fit", label: "Fit", type: "select" as const, required: true,
            options: [{ value: "regular", label: "Regular" }, { value: "slim", label: "Slim", price: 100 }],
        },
    ],
};

function setup() {
    const harness = createSqliteD1Database();
    const product = (id: string) => harness.sqlite.prepare(
        "SELECT customization_schema, aggregate_revision, is_gift_card FROM products WHERE id = ?",
    ).get(id);
    const kinds = (id: string) => harness.sqlite.prepare(
        "SELECT sku, fulfillment_kind, deleted_at IS NOT NULL AS retired FROM product_variants WHERE product_id = ? ORDER BY sku",
    ).all(id);
    const authorityRevision = () => Number(harness.sqlite.prepare(
        "SELECT revision FROM checkout_authority WHERE id = 'default'",
    ).get()?.revision);
    return { ...harness, product, kinds, authorityRevision };
}

const matrixRow = (id: string, valueId: string, sku: string, extra: Record<string, unknown> = {}) => ({
    id, selectedOptionValueIds: [valueId], imageId: null, sku, price: 500, trackInventory: false, weight: null,
    barcode: null, barcodeType: null, discountType: "percentage" as const, discountPercentage: 0, discountAmount: null,
    ...extra,
});

async function createOptioned(db: ReturnType<typeof setup>["db"]) {
    return createProduct(db, createProductSchema.parse({
        ...baseInput,
        optionMatrix: {
            options: [{
                id: "draft_opt_size", name: "Size", standardMapping: "size",
                values: [{ id: "draft_val_s", value: "S" }, { id: "draft_val_m", value: "M" }],
            }],
            variants: [
                matrixRow("draft_var_s", "draft_val_s", "MUG-S"),
                matrixRow("draft_var_m", "draft_val_m", "MUG-M", { fulfillmentKind: "service" }),
            ],
        },
    }));
}

function updateInput(id: string, expectedAggregateRevision: number, extra: Record<string, unknown> = {}) {
    return updateProductSchema.parse({ ...baseInput, id, expectedAggregateRevision, ...extra });
}

describe("product writes persist buyer inputs and fulfilment kinds", () => {
    it("stores the buyer-input schema in minor units and reads it back in the decimal contract", async () => {
        const { db, product, kinds } = setup();
        const { id } = await createProduct(db, createProductSchema.parse({
            ...baseInput,
            customizationSchema: buyerInputs,
            fulfillmentKind: "service",
        }));

        const stored = JSON.parse(String(product(id)?.customization_schema));
        expect(stored.fields[0]).toMatchObject({ key: "engraving", type: "text", priceMinor: 20_000, maxLength: 30 });
        expect(stored.fields[1].options[1]).toEqual({ value: "slim", label: "Slim", priceMinor: 10_000 });
        expect(product(id)?.is_gift_card).toBe(0);
        expect(kinds(id)).toEqual([expect.objectContaining({ fulfillment_kind: "service", retired: 0 })]);

        const details = await getProductDetails(db, id);
        expect(details?.customizationSchemaInvalid).toBe(false);
        expect(details?.customizationSchema?.fields.map((field) => ({
            key: field.key, required: field.required, price: field.price,
            options: field.options.map((option) => option.price),
        }))).toEqual([
            { key: "engraving", required: false, price: 200, options: [] },
            { key: "fit", required: true, price: 0, options: [0, 100] },
        ]);
    });

    it("refuses a surcharge that is not whole taka", async () => {
        const { db, sqlite } = setup();
        await expect(createProduct(db, createProductSchema.parse({
            ...baseInput,
            customizationSchema: { fields: [{ key: "wrap", label: "Gift wrap", type: "checkbox", price: 50.5 }] },
        }))).rejects.toBeInstanceOf(ValidationError);
        expect(sqlite.prepare("SELECT COUNT(*) AS count FROM products").get()?.count).toBe(0);
    });

    it("gives option rows their own kind, else the product kind, else physical", async () => {
        const { db, kinds } = setup();
        const { id } = await createOptioned(db);
        expect(kinds(id)).toEqual([
            { sku: "MUG-M", fulfillment_kind: "service", retired: 0 },
            { sku: "MUG-S", fulfillment_kind: "physical", retired: 0 },
        ]);
    });

    it("updates the schema and every live SKU's kind in one revision and fences checkouts", async () => {
        const { db, sqlite, product, kinds, authorityRevision } = setup();
        const { id } = await createOptioned(db);
        sqlite.prepare("UPDATE product_variants SET deleted_at = unixepoch() WHERE sku = 'MUG-M'").run();
        const retiredRevision = Number(product(id)?.aggregate_revision);
        const before = authorityRevision();

        const result = await updateProduct(db, id, updateInput(id, retiredRevision, {
            customizationSchema: buyerInputs,
            fulfillmentKind: "service",
        }));

        expect(result.aggregateRevision).toBe(retiredRevision + 1);
        expect(product(id)?.aggregate_revision).toBe(retiredRevision + 1);
        expect(JSON.parse(String(product(id)?.customization_schema)).fields).toHaveLength(2);
        expect(kinds(id)).toEqual([
            // A retired SKU keeps its kind; only live SKUs follow the product.
            { sku: "MUG-M", fulfillment_kind: "service", retired: 1 },
            { sku: "MUG-S", fulfillment_kind: "service", retired: 0 },
        ]);
        expect(authorityRevision()).toBeGreaterThan(before);
    });

    it("keeps the schema when omitted, clears it with null, and bumps the checkout authority on change", async () => {
        const { db, product, authorityRevision } = setup();
        const { id } = await createProduct(db, createProductSchema.parse({ ...baseInput, customizationSchema: buyerInputs }));
        const stored = product(id)?.customization_schema;

        await updateProduct(db, id, updateInput(id, 1));
        expect(product(id)?.customization_schema).toBe(stored);

        const before = authorityRevision();
        await updateProduct(db, id, updateInput(id, 2, { customizationSchema: null }));
        expect(product(id)?.customization_schema).toBeNull();
        expect(product(id)?.aggregate_revision).toBe(3);
        expect(authorityRevision()).toBe(before + 1);
    });

    it("rolls back the schema and kinds when the aggregate revision is stale", async () => {
        const { db, product, kinds } = setup();
        const { id } = await createProduct(db, createProductSchema.parse(baseInput));
        await expect(updateProduct(db, id, updateInput(id, 7, {
            customizationSchema: buyerInputs,
            fulfillmentKind: "service",
        }))).rejects.toMatchObject({ code: "PRODUCT_REVISION_CONFLICT" });
        expect(product(id)).toMatchObject({ customization_schema: null, aggregate_revision: 1 });
        expect(kinds(id)).toEqual([expect.objectContaining({ fulfillment_kind: "physical" })]);
    });

    it("honours the kind on variant create, update and option-matrix save, keeping it when omitted", async () => {
        const { db, sqlite, kinds } = setup();
        const { id } = await createOptioned(db);
        const values = sqlite.prepare(
            "SELECT v.id, v.value, d.id AS option_id FROM product_option_values v JOIN product_option_definitions d ON d.id = v.option_definition_id WHERE d.product_id = ? ORDER BY v.position",
        ).all(id) as Array<{ id: string; value: string; option_id: string }>;
        const variantId = (sku: string) => String(sqlite.prepare("SELECT id FROM product_variants WHERE sku = ?").get(sku)?.id);
        const revision = () => Number(sqlite.prepare("SELECT aggregate_revision FROM products WHERE id = ?").get(id)?.aggregate_revision);

        // Saved rows without a kind keep theirs; a new row without one is physical.
        await saveProductOptionMatrix(db, id, {
            expectedAggregateRevision: revision(),
            options: [{
                id: values[0]!.option_id, name: "Size", standardMapping: "size",
                values: [...values.map((value) => ({ id: value.id, value: value.value })), { id: "draft_val_l", value: "L" }],
            }],
            variants: [
                matrixRow(variantId("MUG-S"), values[0]!.id, "MUG-S", { fulfillmentKind: "service" }),
                matrixRow(variantId("MUG-M"), values[1]!.id, "MUG-M"),
                matrixRow("draft_var_l", "draft_val_l", "MUG-L"),
            ],
        });
        expect(kinds(id)).toEqual([
            { sku: "MUG-L", fulfillment_kind: "physical", retired: 0 },
            { sku: "MUG-M", fulfillment_kind: "service", retired: 0 },
            { sku: "MUG-S", fulfillment_kind: "service", retired: 0 },
        ]);

        const valueL = String(sqlite.prepare("SELECT id FROM product_option_values WHERE value = 'L'").get()?.id);
        await updateVariant(db, id, variantId("MUG-L"), {
            ...matrixRow(variantId("MUG-L"), valueL, "MUG-L"),
            expectedAggregateRevision: revision(),
            fulfillmentKind: "service",
        });
        await updateVariant(db, id, variantId("MUG-M"), {
            ...matrixRow(variantId("MUG-M"), values[1]!.id, "MUG-M"),
            expectedAggregateRevision: revision(),
        });
        expect(kinds(id).map((row) => row.fulfillment_kind)).toEqual(["service", "service", "service"]);

        sqlite.prepare("DELETE FROM product_variant_option_values WHERE variant_id = ?").run(variantId("MUG-L"));
        sqlite.prepare("UPDATE product_variants SET deleted_at = unixepoch(), sku = 'MUG-L-OLD' WHERE sku = 'MUG-L'").run();
        const created = await createVariant(db, id, {
            ...matrixRow("unused", valueL, "MUG-L2"),
            stock: 0,
            expectedAggregateRevision: revision(),
        });
        expect(created.fulfillmentKind).toBe("physical");
    });

    it("copies buyer inputs and service kinds into a duplicate without the gift-card flag", async () => {
        const { db, product, kinds } = setup();
        const { id } = await createProduct(db, createProductSchema.parse({
            ...baseInput, customizationSchema: buyerInputs, fulfillmentKind: "service",
        }));
        const copy = await duplicateProduct(db, id, "Engraved mug copy");
        expect(product(copy.id)?.customization_schema).toBe(product(id)?.customization_schema);
        expect(product(copy.id)?.is_gift_card).toBe(0);
        expect(kinds(copy.id)).toEqual([expect.objectContaining({ fulfillment_kind: "service" })]);
    });
});
