// Digital stock rules on the product editor's write paths (migrated schema):
// a digital SKU's stock is its licence keys, so create, update, variant and
// option-matrix saves never give it a quantity, physical units never become
// keys, and a digital SKU with a ready key pool keeps tracking quantity.
import type { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ValidationError } from "@scalius/core/errors";
import { createProduct, updateProduct } from "./write";
import { createProductSchema, updateProductSchema, type CreateProductInput } from "./validation";
import { createVariant, updateVariant } from "./variants";
import { saveProductOptionMatrix } from "./option-matrix";
import {
    DIGITAL_KEY_POOL_NEEDS_TRACKING_MESSAGE,
    DIGITAL_KEYS_KEEP_KIND_MESSAGE,
    DIGITAL_KIND_NEEDS_ZERO_STOCK_MESSAGE,
    DIGITAL_STOCK_CANT_SPLIT_MESSAGE,
    DIGITAL_STOCK_IS_KEYS_MESSAGE,
    DIGITAL_STOCK_IS_KEYS_REASON,
} from "../products/digital-stock-rules";
import { createDigitalAsset } from "../digital/assets";
import { importLicenceKeys, revokeLicenceKeys, listLicenceKeys } from "../digital/licence-keys";

const CREDENTIAL_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 3)));

const baseInput = {
    name: "Photo editor",
    description: null,
    price: 900,
    categoryId: null,
    isActive: false,
    discountType: "percentage" as const,
    discountPercentage: 0,
    discountAmount: 0,
    freeDelivery: false,
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    productCondition: "new" as const,
    media: [],
    attributes: [],
    additionalInfo: [],
};

const row = (id: string, valueId: string, sku: string, extra: Record<string, unknown> = {}) => ({
    id, selectedOptionValueIds: [valueId], imageId: null, sku, price: 500, trackInventory: true, weight: null,
    barcode: null, barcodeType: null, discountType: "percentage" as const, discountPercentage: 0, discountAmount: null,
    ...extra,
});

type Harness = {
    sqlite: DatabaseSync;
    db: Database;
    /** Runs once, right before the next writing batch opens its transaction (a concurrent write). */
    race: (write: (sqlite: DatabaseSync) => void) => void;
};

function setup(): Harness {
    let pending: ((sqlite: DatabaseSync) => void) | null = null;
    const { sqlite, db } = createSqliteD1Database({
        beforeBatch: (connection, statements) => {
            if (!statements.some((statement) => /^\s*(insert|update|delete)\b/i.test(statement.query))) return;
            const write = pending;
            pending = null;
            write?.(connection);
        },
    });
    return { sqlite, db, race: (write) => { pending = write; } };
}

const sku = (sqlite: DatabaseSync, code: string) => sqlite.prepare(
    "SELECT id, stock, stock_version, fulfillment_kind, track_inventory FROM product_variants WHERE sku = ?",
).get(code) as { id: string; stock: number; stock_version: number; fulfillment_kind: string; track_inventory: number };

const revision = (sqlite: DatabaseSync, productId: string) =>
    Number((sqlite.prepare("SELECT aggregate_revision AS r FROM products WHERE id = ?").get(productId) as { r: number }).r);

async function expectDigitalError(promise: Promise<unknown>, message: string, field?: string) {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe(message);
    expect((error as ValidationError).details).toMatchObject({
        reason: DIGITAL_STOCK_IS_KEYS_REASON,
        ...(field ? { field } : {}),
    });
}

/** A simple product whose single SKU is created as given. */
async function simpleProduct(db: Database, slug: string, code: string, defaultSku: Record<string, unknown>) {
    return createProduct(db, createProductSchema.parse({
        ...baseInput,
        slug,
        defaultSku: { sku: code, trackInventory: true, stock: 0, ...defaultSku },
    }));
}

/** A key pool on the SKU and `count` keys imported into it (pool = stock). */
async function importKeys(db: Database, productId: string, variantId: string, count: number) {
    const { asset } = await createDigitalAsset(db, undefined, productId, { kind: "licence_keys", variantId });
    await importLicenceKeys(db, {
        assetId: asset.id,
        keys: Array.from({ length: count }, (_, index) => `KEY-${variantId}-${index}`),
        requestKey: crypto.randomUUID(),
        credentialKey: CREDENTIAL_KEY,
    });
    return asset.id;
}

const updateInput = (id: string, expectedAggregateRevision: number, slug: string, extra: Record<string, unknown> = {}) =>
    updateProductSchema.parse({ ...baseInput, slug, id, expectedAggregateRevision, ...extra });

describe("digital stock rules on product writes", () => {
    beforeAll(() => createSqliteD1Database().sqlite.close(), 30_000);

    it("refuses a quantity on a digital SKU at create (schema issue and core check)", async () => {
        const issues = (input: unknown) => {
            const parsed = createProductSchema.safeParse(input);
            return parsed.success ? [] : parsed.error.issues.map((issue) => [issue.path.join("."), issue.message]);
        };
        expect(issues({ ...baseInput, fulfillmentKind: "digital", defaultSku: { trackInventory: true, stock: 5 } }))
            .toEqual([["defaultSku.stock", DIGITAL_STOCK_IS_KEYS_MESSAGE]]);
        expect(issues({
            ...baseInput,
            optionMatrix: {
                options: [{ id: "o", name: "Licence", standardMapping: "none", values: [{ id: "a", value: "1 seat" }, { id: "b", value: "5 seats" }] }],
                variants: [
                    row("ra", "a", "PE-1", { stock: 0, fulfillmentKind: "digital" }),
                    row("rb", "b", "PE-5", { stock: 3, fulfillmentKind: "digital" }),
                ],
            },
        })).toEqual([["optionMatrix.variants.1.stock", DIGITAL_STOCK_IS_KEYS_MESSAGE]]);
        // The product's kind applies to a SKU that names none.
        const parsed = createProductSchema.safeParse({ ...baseInput, fulfillmentKind: "digital", defaultSku: { trackInventory: true, stock: 2 } });
        expect(parsed.success ? null : parsed.error.issues[0]).toMatchObject({ params: { reason: DIGITAL_STOCK_IS_KEYS_REASON } });

        // createProduct refuses it for callers that skip the schema too.
        const { db, sqlite } = setup();
        const unchecked = {
            ...createProductSchema.parse({ ...baseInput, slug: "raw", defaultSku: { sku: "RAW-1", trackInventory: true, stock: 0 } }),
            fulfillmentKind: "digital",
            defaultSku: { sku: "RAW-1", trackInventory: true, stock: 4, fulfillmentKind: "digital" },
        } as CreateProductInput;
        await expectDigitalError(createProduct(db, unchecked), DIGITAL_STOCK_IS_KEYS_MESSAGE, "defaultSku.stock");
        expect(sqlite.prepare("SELECT count(*) AS n FROM products").get()).toEqual({ n: 0 });

        // A tracked digital SKU without a quantity is fine: keys are its stock.
        await simpleProduct(db, "keys-only", "OK-1", { fulfillmentKind: "digital" });
        expect(sku(sqlite, "OK-1")).toMatchObject({ stock: 0, fulfillment_kind: "digital", track_inventory: 1 });
    });

    it("turns a product digital only when its SKUs hold no stock (Shipping card)", async () => {
        const { db, sqlite, race } = setup();
        const stocked = await simpleProduct(db, "mug", "MUG-1", { stock: 4 });
        await expectDigitalError(
            updateProduct(db, stocked.id, updateInput(stocked.id, 1, "mug", { fulfillmentKind: "digital" })),
            DIGITAL_KIND_NEEDS_ZERO_STOCK_MESSAGE,
            "fulfillmentKind",
        );
        expect(sku(sqlite, "MUG-1")).toMatchObject({ stock: 4, fulfillment_kind: "physical" });
        expect(revision(sqlite, stocked.id)).toBe(1);

        const empty = await simpleProduct(db, "ebook", "EBOOK-1", { stock: 0 });
        await updateProduct(db, empty.id, updateInput(empty.id, 1, "ebook", { fulfillmentKind: "digital" }));
        expect(sku(sqlite, "EBOOK-1")).toMatchObject({ stock: 0, fulfillment_kind: "digital" });

        // Keys never become physical units: digital → physical waits until its unused keys are revoked.
        const assetId = await importKeys(db, empty.id, sku(sqlite, "EBOOK-1").id, 2);
        for (const kind of ["physical", "service"] as const) {
            await expectDigitalError(
                updateProduct(db, empty.id, updateInput(empty.id, 2, "ebook", { fulfillmentKind: kind })),
                DIGITAL_KEYS_KEEP_KIND_MESSAGE,
                "fulfillmentKind",
            );
        }
        expect(sku(sqlite, "EBOOK-1")).toMatchObject({ stock: 2, fulfillment_kind: "digital" });
        expect(revision(sqlite, empty.id)).toBe(2);
        // A key imported while the kind change is in flight aborts it (batch guard).
        const keys = await listLicenceKeys(db, { assetId, status: "available" });
        await revokeLicenceKeys(db, { assetId, keyIds: keys.items.map((key) => key.id), requestKey: crypto.randomUUID() });
        expect(sku(sqlite, "EBOOK-1")).toMatchObject({ stock: 0, fulfillment_kind: "digital" });
        race((connection) => {
            connection.prepare(`INSERT INTO digital_licence_keys (id, asset_id, key_ciphertext, key_hash, key_last4, status, import_id)
                VALUES ('raced_key', ?, 'x', 'raced-hash', 'ABCD', 'available', 'raced_import')`).run(assetId);
        });
        await expectDigitalError(
            updateProduct(db, empty.id, updateInput(empty.id, 2, "ebook", { fulfillmentKind: "physical" })),
            DIGITAL_KEYS_KEEP_KIND_MESSAGE,
        );
        expect(sku(sqlite, "EBOOK-1")).toMatchObject({ fulfillment_kind: "digital" });
        sqlite.prepare("UPDATE digital_licence_keys SET status = 'revoked', revoked_at = unixepoch() WHERE id = 'raced_key'").run();
        // Revoked: it holds no keys and no stock, so it may stop being digital.
        await updateProduct(db, empty.id, updateInput(empty.id, 2, "ebook", { fulfillmentKind: "physical" }));
        expect(sku(sqlite, "EBOOK-1")).toMatchObject({ stock: 0, fulfillment_kind: "physical" });

        // A unit counted in between the read and the commit aborts the kind change (batch guard).
        const raced = await simpleProduct(db, "pen", "PEN-1", { stock: 0 });
        race((connection) => {
            connection.prepare("UPDATE product_variants SET stock = 2, stock_version = stock_version + 1 WHERE sku = 'PEN-1'").run();
        });
        await expectDigitalError(
            updateProduct(db, raced.id, updateInput(raced.id, 1, "pen", { fulfillmentKind: "digital" })),
            DIGITAL_KIND_NEEDS_ZERO_STOCK_MESSAGE,
        );
        expect(sku(sqlite, "PEN-1")).toMatchObject({ stock: 2, fulfillment_kind: "physical" });
        expect(revision(sqlite, raced.id)).toBe(1);
    });

    it("keeps a gift card conversion as it was (gift cards are untracked)", async () => {
        const { db, sqlite } = setup();
        const product = await simpleProduct(db, "card", "CARD-1", { stock: 4 });
        await updateProduct(db, product.id, updateInput(product.id, 1, "card", { isGiftCard: true }));
        expect(sku(sqlite, "CARD-1")).toMatchObject({ fulfillment_kind: "digital", track_inventory: 0 });
    });

    it("refuses a quantity edit on a digital SKU, and lets an unchanged one through (variant save)", async () => {
        const { db, sqlite } = setup();
        const product = await simpleProduct(db, "app", "APP-1", { fulfillmentKind: "digital" });
        const variantId = sku(sqlite, "APP-1").id;
        const poolId = await importKeys(db, product.id, variantId, 3);
        const current = sku(sqlite, "APP-1");
        const base = { selectedOptionValueIds: [], imageId: null, weight: null, sku: "APP-1", price: 900, trackInventory: true };

        await expectDigitalError(updateVariant(db, product.id, variantId, {
            ...base, stock: 10, expectedStockVersion: current.stock_version, expectedAggregateRevision: revision(sqlite, product.id),
        }), DIGITAL_STOCK_IS_KEYS_MESSAGE, "stock");
        expect(sku(sqlite, "APP-1")).toMatchObject({ stock: 3, stock_version: current.stock_version });

        // The editor resends the saved quantity: a no-op for stock.
        await updateVariant(db, product.id, variantId, {
            ...base, sku: "APP-1B", stock: 3, expectedStockVersion: current.stock_version, expectedAggregateRevision: revision(sqlite, product.id),
        });
        expect(sku(sqlite, "APP-1B")).toMatchObject({ stock: 3, stock_version: current.stock_version });

        // Tracking off would let checkout ignore the keys left.
        await expectDigitalError(updateVariant(db, product.id, variantId, {
            ...base, sku: "APP-1B", trackInventory: false, expectedAggregateRevision: revision(sqlite, product.id),
        }), DIGITAL_KEY_POOL_NEEDS_TRACKING_MESSAGE, "trackInventory");
        expect(sku(sqlite, "APP-1B")).toMatchObject({ track_inventory: 1 });

        // Turning physical with 3 keys left would make them 3 typed-in units beside
        // 3 undelivered keys (the editor then showed both): refused until they are revoked.
        await expectDigitalError(updateVariant(db, product.id, variantId, {
            ...base, sku: "APP-1B", fulfillmentKind: "physical", expectedAggregateRevision: revision(sqlite, product.id),
        }), DIGITAL_KEYS_KEEP_KIND_MESSAGE, "fulfillmentKind");
        expect(sku(sqlite, "APP-1B")).toMatchObject({ stock: 3, fulfillment_kind: "digital" });
        const unused = await listLicenceKeys(db, { assetId: poolId, status: "available" });
        await revokeLicenceKeys(db, { assetId: poolId, keyIds: unused.items.map((key) => key.id), requestKey: crypto.randomUUID() });
        expect(sku(sqlite, "APP-1B")).toMatchObject({ stock: 0 });

        // Then digital → physical, and a quantity edit as a physical SKU, is fine.
        await updateVariant(db, product.id, variantId, {
            ...base, sku: "APP-1B", fulfillmentKind: "physical", stock: 0,
            expectedStockVersion: sku(sqlite, "APP-1B").stock_version, expectedAggregateRevision: revision(sqlite, product.id),
        });
        await updateVariant(db, product.id, variantId, {
            ...base, sku: "APP-1B", fulfillmentKind: "physical", stock: 7,
            expectedStockVersion: sku(sqlite, "APP-1B").stock_version, expectedAggregateRevision: revision(sqlite, product.id),
        });
        expect(sku(sqlite, "APP-1B")).toMatchObject({ stock: 7, fulfillment_kind: "physical" });
    });

    it("turns a SKU digital only without stock; a write-off in the same save is fine (variant save)", async () => {
        const { db, sqlite, race } = setup();
        const product = await simpleProduct(db, "lamp", "LAMP-1", { stock: 5 });
        const variant = sku(sqlite, "LAMP-1");
        const base = { selectedOptionValueIds: [], imageId: null, weight: null, sku: "LAMP-1", price: 900, trackInventory: true };

        await expectDigitalError(updateVariant(db, product.id, variant.id, {
            ...base, fulfillmentKind: "digital", expectedAggregateRevision: 1,
        }), DIGITAL_KIND_NEEDS_ZERO_STOCK_MESSAGE, "fulfillmentKind");
        expect(sku(sqlite, "LAMP-1")).toMatchObject({ stock: 5, fulfillment_kind: "physical" });

        // Units counted in between the read and the commit abort it (batch guard).
        const bulb = await simpleProduct(db, "bulb", "BULB-1", { stock: 0 });
        const bulbId = sku(sqlite, "BULB-1").id;
        race((connection) => {
            connection.prepare("UPDATE product_variants SET stock = 3, stock_version = stock_version + 1 WHERE sku = 'BULB-1'").run();
        });
        await expectDigitalError(updateVariant(db, bulb.id, bulbId, {
            ...base, sku: "BULB-1", fulfillmentKind: "digital", expectedAggregateRevision: 1,
        }), DIGITAL_KIND_NEEDS_ZERO_STOCK_MESSAGE);
        expect(sku(sqlite, "BULB-1")).toMatchObject({ stock: 3, fulfillment_kind: "physical" });

        await updateVariant(db, product.id, variant.id, {
            ...base, fulfillmentKind: "digital", stock: 0, expectedStockVersion: variant.stock_version, expectedAggregateRevision: 1,
        });
        expect(sku(sqlite, "LAMP-1")).toMatchObject({ stock: 0, fulfillment_kind: "digital" });
        expect(sqlite.prepare("SELECT quantity, notes FROM inventory_movements WHERE variant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(variant.id))
            .toEqual({ quantity: -5, notes: "Stocktake: Product variant edit" });
    });

    it("creates a digital option SKU only without a quantity (variant create)", async () => {
        const { db, sqlite } = setup();
        const product = await createProduct(db, createProductSchema.parse({
            ...baseInput,
            slug: "course",
            optionMatrix: {
                options: [{ id: "o", name: "Plan", standardMapping: "none", values: [{ id: "a", value: "Basic" }] }],
                variants: [row("ra", "a", "COURSE-BASIC", { stock: 0, fulfillmentKind: "digital" })],
            },
        }));
        const optionId = String((sqlite.prepare("SELECT id FROM product_option_definitions WHERE product_id = ?").get(product.id) as { id: string }).id);
        sqlite.prepare("INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES ('pval_pro', ?, 'Pro', 'pro', 1)").run(optionId);
        const { id: _draftId, ...fields } = row("x", "pval_pro", "COURSE-PRO");
        const draft = { ...fields, fulfillmentKind: "digital" as const, expectedAggregateRevision: 1 };
        await expectDigitalError(createVariant(db, product.id, { ...draft, stock: 2 }), DIGITAL_STOCK_IS_KEYS_MESSAGE, "stock");
        await createVariant(db, product.id, { ...draft, stock: 0 });
        expect(sku(sqlite, "COURSE-PRO")).toMatchObject({ stock: 0, fulfillment_kind: "digital" });
    });

    it("keeps digital rows' stock in option-matrix saves, bulk quantity edits included", async () => {
        const { db, sqlite } = setup();
        const product = await createProduct(db, createProductSchema.parse({
            ...baseInput,
            slug: "font",
            optionMatrix: {
                options: [{ id: "o", name: "Licence", standardMapping: "none", values: [{ id: "a", value: "Desktop" }, { id: "b", value: "Print" }] }],
                variants: [
                    row("ra", "a", "FONT-DESKTOP", { stock: 0, fulfillmentKind: "digital" }),
                    row("rb", "b", "FONT-PRINT", { stock: 6, fulfillmentKind: "physical" }),
                ],
            },
        }));
        const desktop = sku(sqlite, "FONT-DESKTOP");
        const print = sku(sqlite, "FONT-PRINT");
        await importKeys(db, product.id, desktop.id, 2);
        const optionId = String((sqlite.prepare("SELECT id FROM product_option_definitions WHERE product_id = ?").get(product.id) as { id: string }).id);
        const valueOf = (variantId: string) => String((sqlite.prepare("SELECT option_value_id AS v FROM product_variant_option_values WHERE variant_id = ?").get(variantId) as { v: string }).v);
        const options = (extra: Array<{ id: string; value: string }> = []) => [{
            id: optionId, name: "Licence", standardMapping: "none" as const,
            values: [{ id: valueOf(desktop.id), value: "Desktop" }, { id: valueOf(print.id), value: "Print" }, ...extra],
        }];
        const saved = (variantId: string, code: string, extra: Record<string, unknown> = {}) => row(variantId, valueOf(variantId), code, extra);
        const save = (variants: unknown[], extraValues: Array<{ id: string; value: string }> = []) =>
            saveProductOptionMatrix(db, product.id, { expectedAggregateRevision: revision(sqlite, product.id), options: options(extraValues), variants });
        const desktopVersion = sku(sqlite, "FONT-DESKTOP").stock_version;

        // Bulk "set quantity to 10" on every selected row reaches the digital one too.
        await expectDigitalError(save([
            saved(desktop.id, "FONT-DESKTOP", { stock: 10, expectedStockVersion: desktopVersion }),
            saved(print.id, "FONT-PRINT", { stock: 10, expectedStockVersion: print.stock_version }),
        ]), DIGITAL_STOCK_IS_KEYS_MESSAGE, "variants.0.stock");
        expect([sku(sqlite, "FONT-DESKTOP").stock, sku(sqlite, "FONT-PRINT").stock]).toEqual([2, 6]);

        // Resending the saved quantity (or omitting it) changes nothing on the digital row.
        await save([
            saved(desktop.id, "FONT-DESKTOP", { stock: 2, expectedStockVersion: desktopVersion }),
            saved(print.id, "FONT-PRINT", { stock: 10, expectedStockVersion: print.stock_version }),
        ]);
        expect([sku(sqlite, "FONT-DESKTOP").stock, sku(sqlite, "FONT-PRINT").stock]).toEqual([2, 10]);

        // A new digital combination starts at 0.
        await expectDigitalError(save([
            saved(desktop.id, "FONT-DESKTOP"),
            saved(print.id, "FONT-PRINT"),
            row("draft_web", "draft_web_value", "FONT-WEB", { stock: 4, fulfillmentKind: "digital" }),
        ], [{ id: "draft_web_value", value: "Web" }]), DIGITAL_STOCK_IS_KEYS_MESSAGE, "variants.2.stock");

        // A physical row with stock can't turn digital; the key pool keeps tracking on.
        await expectDigitalError(save([
            saved(desktop.id, "FONT-DESKTOP"),
            saved(print.id, "FONT-PRINT", { fulfillmentKind: "digital" }),
        ]), DIGITAL_KIND_NEEDS_ZERO_STOCK_MESSAGE, "variants.1.fulfillmentKind");
        await expectDigitalError(save([
            saved(desktop.id, "FONT-DESKTOP", { trackInventory: false }),
            saved(print.id, "FONT-PRINT"),
        ]), DIGITAL_KEY_POOL_NEEDS_TRACKING_MESSAGE, "variants.0.trackInventory");
        expect(sku(sqlite, "FONT-PRINT")).toMatchObject({ stock: 10, fulfillment_kind: "physical" });
        expect(sku(sqlite, "FONT-DESKTOP")).toMatchObject({ stock: 2, track_inventory: 1 });
    });

    it("refuses to share a digital simple SKU's keys out across new options", async () => {
        const { db, sqlite } = setup();
        const product = await simpleProduct(db, "suite", "SUITE-1", { fulfillmentKind: "digital" });
        const variantId = sku(sqlite, "SUITE-1").id;
        const assetId = await importKeys(db, product.id, variantId, 2);
        const matrix = {
            options: [{ id: "draft_o", name: "Seats", standardMapping: "none" as const, values: [{ id: "draft_1", value: "1" }] }],
            variants: [row("draft_r", "draft_1", "SUITE-1-SEAT", { stock: 0, fulfillmentKind: "digital" })],
        };
        await expectDigitalError(
            saveProductOptionMatrix(db, product.id, { ...matrix, expectedAggregateRevision: revision(sqlite, product.id) }),
            DIGITAL_STOCK_CANT_SPLIT_MESSAGE,
            "variants",
        );
        expect(sku(sqlite, "SUITE-1")).toMatchObject({ stock: 2 });

        // Revoking the keys empties it; then options can be added.
        const keys = await listLicenceKeys(db, { assetId, status: "available" });
        await revokeLicenceKeys(db, { assetId, keyIds: keys.items.map((key) => key.id), requestKey: crypto.randomUUID() });
        await saveProductOptionMatrix(db, product.id, { ...matrix, expectedAggregateRevision: revision(sqlite, product.id) });
        expect(sku(sqlite, "SUITE-1-SEAT")).toMatchObject({ stock: 0, fulfillment_kind: "digital" });
    });
});
