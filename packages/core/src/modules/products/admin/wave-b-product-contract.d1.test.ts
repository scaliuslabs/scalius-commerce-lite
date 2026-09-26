import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ConflictError, ValidationError } from "@scalius/core/errors";
import { createProduct, duplicateProduct, updateProduct } from "./write";
import { getProductDetails } from "./read";
import { createProductSchema, updateProductSchema } from "../validation";
import { createVariant, updateVariant } from "../variants";
import { saveProductOptionMatrix } from "../option-matrix";
import { updateProductSemanticSection } from "../semantic-sections";
import { GIFT_CARD_PRODUCT_RULES_MESSAGE } from "../gift-card-rules";

vi.mock("../../inventory/alerts", () => ({ checkAndAlertLowStock: vi.fn() }));

/**
 * Wave B product contract (design §4.2, §5.1): digital kinds are accepted, a
 * gift-card product keeps every live SKU digital, untracked and undiscounted
 * on every write path, and a product references a live warranty policy.
 */

const baseInput = {
    name: "Store gift card",
    description: null,
    price: 1000,
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
    slug: "store-gift-card",
    media: [],
    attributes: [],
    additionalInfo: [],
};

const matrixRow = (id: string, valueId: string, sku: string, extra: Record<string, unknown> = {}) => ({
    id, selectedOptionValueIds: [valueId], imageId: null, sku, price: 500, trackInventory: false, weight: null,
    barcode: null, barcodeType: null, discountType: "percentage" as const, discountPercentage: 0, discountAmount: null,
    ...extra,
});

function setup() {
    const harness = createSqliteD1Database();
    harness.sqlite.exec(`
      INSERT INTO warranty_policies (id, name, provider, duration_value, duration_unit, current_revision_id, archived_at)
        VALUES ('wrp_live_policy1', '1 year brand warranty', 'brand', 1, 'years', 'wrr_live_rev0001', NULL),
               ('wrp_archived_pol', 'Old warranty', 'store', 6, 'months', 'wrr_archived_rev', 1780000000);
    `);
    const product = (id: string) => harness.sqlite.prepare(
        "SELECT is_gift_card, warranty_policy_id, aggregate_revision, discount_bps, discount_amount_minor FROM products WHERE id = ?",
    ).get(id);
    const skus = (id: string) => harness.sqlite.prepare(
        "SELECT sku, fulfillment_kind, track_inventory, discount_bps, discount_amount_minor FROM product_variants WHERE product_id = ? AND deleted_at IS NULL ORDER BY sku",
    ).all(id);
    return { ...harness, product, skus };
}

function updateInput(id: string, expectedAggregateRevision: number, extra: Record<string, unknown> = {}) {
    return updateProductSchema.parse({ ...baseInput, id, expectedAggregateRevision, ...extra });
}

describe("Wave B product contract", () => {
    // Build the migrated schema once in a hook, not inside the first test's time budget.
    beforeAll(() => createSqliteD1Database().sqlite.close(), 30_000);

    it("creates a gift card with a digital, untracked default SKU", async () => {
        const { db, product, skus } = setup();
        const { id } = await createProduct(db, createProductSchema.parse({ ...baseInput, isGiftCard: true }));
        expect(product(id)).toMatchObject({ is_gift_card: 1 });
        expect(skus(id)).toEqual([expect.objectContaining({ fulfillment_kind: "digital", track_inventory: 0 })]);
        expect((await getProductDetails(db, id))?.isGiftCard).toBe(true);
    });

    it("accepts the digital kind on a normal product", async () => {
        const { db, skus } = setup();
        const { id } = await createProduct(db, createProductSchema.parse({ ...baseInput, fulfillmentKind: "digital" }));
        expect(skus(id)).toEqual([expect.objectContaining({ fulfillment_kind: "digital" })]);
    });

    it("turns a product into a gift card: every live SKU digital and untracked in one revision", async () => {
        const { db, sqlite, product, skus } = setup();
        const { id } = await createProduct(db, createProductSchema.parse({
            ...baseInput,
            defaultSku: { trackInventory: true, stock: 4, fulfillmentKind: "physical" },
        }));
        const result = await updateProduct(db, id, updateInput(id, 1, { isGiftCard: true }));
        expect(result.aggregateRevision).toBe(2);
        expect(product(id)).toMatchObject({ is_gift_card: 1, aggregate_revision: 2 });
        expect(skus(id)).toEqual([expect.objectContaining({ fulfillment_kind: "digital", track_inventory: 0 })]);

        // Omitted keeps the flag; a later save can't bring back a physical kind or a discount.
        await expect(updateProduct(db, id, updateInput(id, 2, { fulfillmentKind: "physical" })))
            .rejects.toThrow("Gift cards are delivered digitally.");
        await expect(updateProduct(db, id, updateInput(id, 2, { discountPercentage: 10 })))
            .rejects.toThrow("Gift cards can't be discounted.");
        expect(product(id)).toMatchObject({ is_gift_card: 1, aggregate_revision: 2, discount_bps: 0 });

        // Turning it off keeps the SKUs as they are.
        await updateProduct(db, id, updateInput(id, 2, { isGiftCard: false }));
        expect(product(id)).toMatchObject({ is_gift_card: 0 });
        expect(sqlite.prepare("SELECT fulfillment_kind FROM product_variants WHERE product_id = ?").get(id))
            .toEqual({ fulfillment_kind: "digital" });
    });

    it("refuses a gift card while a SKU is discounted or holds reservations", async () => {
        const { db, sqlite, product } = setup();
        const { id } = await createProduct(db, createProductSchema.parse({
            ...baseInput,
            optionMatrix: {
                options: [{
                    id: "draft_opt", name: "Value", standardMapping: "none",
                    values: [{ id: "draft_500", value: "500" }, { id: "draft_1000", value: "1000" }],
                }],
                variants: [
                    matrixRow("draft_var_500", "draft_500", "GC-500", { discountPercentage: 10 }),
                    matrixRow("draft_var_1000", "draft_1000", "GC-1000", { trackInventory: true }),
                ],
            },
        }));
        await expect(updateProduct(db, id, updateInput(id, 1, { isGiftCard: true })))
            .rejects.toThrow(GIFT_CARD_PRODUCT_RULES_MESSAGE);

        sqlite.prepare("UPDATE product_variants SET discount_bps = 0 WHERE sku = 'GC-500'").run();
        sqlite.prepare("UPDATE product_variants SET stock = 3, reserved_stock = 1 WHERE sku = 'GC-1000'").run();
        await expect(updateProduct(db, id, updateInput(id, 1, { isGiftCard: true })))
            .rejects.toBeInstanceOf(ConflictError);
        expect(product(id)).toMatchObject({ is_gift_card: 0, aggregate_revision: 1 });
    });

    it("keeps the rules on variant, option-matrix and pricing writes (batch guard)", async () => {
        const { db, sqlite, product, skus } = setup();
        const { id } = await createProduct(db, createProductSchema.parse({
            ...baseInput,
            isGiftCard: true,
            optionMatrix: {
                options: [{
                    id: "draft_opt", name: "Value", standardMapping: "none",
                    values: [{ id: "draft_500", value: "500" }],
                }],
                variants: [matrixRow("draft_var_500", "draft_500", "GC-500")],
            },
        }));
        const before = skus(id);
        const revision = () => Number(product(id)?.aggregate_revision);
        const variantId = String(sqlite.prepare("SELECT id FROM product_variants WHERE sku = 'GC-500'").get()?.id);
        const valueId = String(sqlite.prepare("SELECT option_value_id FROM product_variant_option_values WHERE variant_id = ?").get(variantId)?.option_value_id);
        const optionId = String(sqlite.prepare("SELECT id FROM product_option_definitions WHERE product_id = ?").get(id)?.id);

        await expect(updateVariant(db, id, variantId, {
            ...matrixRow(variantId, valueId, "GC-500"),
            trackInventory: true,
            expectedAggregateRevision: revision(),
        })).rejects.toThrow(GIFT_CARD_PRODUCT_RULES_MESSAGE);
        await expect(updateVariant(db, id, variantId, {
            ...matrixRow(variantId, valueId, "GC-500"),
            discountPercentage: 5,
            expectedAggregateRevision: revision(),
        })).rejects.toBeInstanceOf(ValidationError);
        await expect(saveProductOptionMatrix(db, id, {
            expectedAggregateRevision: revision(),
            options: [{
                id: optionId, name: "Value", standardMapping: "none",
                values: [{ id: valueId, value: "500" }, { id: "draft_1000", value: "1000" }],
            }],
            variants: [
                matrixRow(variantId, valueId, "GC-500"),
                matrixRow("draft_var_1000", "draft_1000", "GC-1000", { fulfillmentKind: "physical" }),
            ],
        })).rejects.toThrow(GIFT_CARD_PRODUCT_RULES_MESSAGE);
        await expect(updateProductSemanticSection(db, id, {
            section: "base",
            expectedAggregateRevision: revision(),
            patch: { discountType: "percentage", discountPercentage: 10 },
        })).rejects.toThrow(GIFT_CARD_PRODUCT_RULES_MESSAGE);
        expect(skus(id)).toEqual(before);
        expect(product(id)).toMatchObject({ discount_bps: 0 });
        expect(revision()).toBe(1);

        // A compliant write still goes through, and a new SKU must be sent digital and untracked.
        await saveProductOptionMatrix(db, id, {
            expectedAggregateRevision: revision(),
            options: [{
                id: optionId, name: "Value", standardMapping: "none",
                values: [{ id: valueId, value: "500" }, { id: "draft_1000", value: "1000" }],
            }],
            variants: [
                matrixRow(variantId, valueId, "GC-500"),
                matrixRow("draft_var_1000", "draft_1000", "GC-1000", { fulfillmentKind: "digital" }),
            ],
        });
        expect(skus(id).map((row) => [row.sku, row.fulfillment_kind, row.track_inventory]))
            .toEqual([["GC-1000", "digital", 0], ["GC-500", "digital", 0]]);
        const value1000 = String(sqlite.prepare("SELECT id FROM product_option_values WHERE value = '1000'").get()?.id);
        sqlite.prepare("UPDATE product_variants SET deleted_at = unixepoch(), sku = 'GC-1000-OLD' WHERE sku = 'GC-1000'").run();
        sqlite.prepare("DELETE FROM product_variant_option_values WHERE option_value_id = ?").run(value1000);
        await expect(createVariant(db, id, {
            ...matrixRow("unused", value1000, "GC-1000B"),
            stock: 0,
            expectedAggregateRevision: revision(),
        })).rejects.toThrow(GIFT_CARD_PRODUCT_RULES_MESSAGE);
    });

    it("stores, keeps, clears and copies a live warranty policy and refuses an archived or unknown one", async () => {
        const { db, product } = setup();
        await expect(createProduct(db, createProductSchema.parse({ ...baseInput, warrantyPolicyId: "wrp_archived_pol" })))
            .rejects.toThrow("That warranty policy is unavailable or archived.");
        await expect(createProduct(db, createProductSchema.parse({ ...baseInput, warrantyPolicyId: "wrp_missing_pol1" })))
            .rejects.toBeInstanceOf(ValidationError);

        const { id } = await createProduct(db, createProductSchema.parse({ ...baseInput, warrantyPolicyId: "wrp_live_policy1" }));
        expect(product(id)).toMatchObject({ warranty_policy_id: "wrp_live_policy1" });
        expect((await getProductDetails(db, id))?.warrantyPolicyId).toBe("wrp_live_policy1");

        const copy = await duplicateProduct(db, id, "Store gift card copy");
        expect(product(copy.id)).toMatchObject({ warranty_policy_id: "wrp_live_policy1" });

        // An edit that omits the policy keeps it (a save that changes nothing writes nothing, so rename).
        await updateProduct(db, id, updateInput(id, 1, { name: "Store gift card renamed" }));
        expect(product(id)).toMatchObject({ warranty_policy_id: "wrp_live_policy1", aggregate_revision: 2 });
        await expect(updateProduct(db, id, updateInput(id, 2, { warrantyPolicyId: "wrp_archived_pol" })))
            .rejects.toBeInstanceOf(ValidationError);
        await updateProduct(db, id, updateInput(id, 2, { warrantyPolicyId: null }));
        expect(product(id)).toMatchObject({ warranty_policy_id: null, aggregate_revision: 3 });
    });

    it("copies a gift card as a gift card with digital, untracked SKUs", async () => {
        const { db, product, skus } = setup();
        const { id } = await createProduct(db, createProductSchema.parse({ ...baseInput, isGiftCard: true }));
        const copy = await duplicateProduct(db, id, "Gift card copy");
        expect(product(copy.id)).toMatchObject({ is_gift_card: 1 });
        expect(skus(copy.id)).toEqual([expect.objectContaining({ fulfillment_kind: "digital", track_inventory: 0 })]);
    });
});
