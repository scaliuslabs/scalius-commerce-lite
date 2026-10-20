// Digital stock rules on the inventory paths (migrated schema): a digital
// SKU's stock is its licence keys, so manual adjustments, scanner adjustments
// and counts, purchase orders and transfers never move it, while key import
// and revoke still do. A SKU that turns digital while one of these writes is
// in flight is refused by the write's batch guard.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ValidationError } from "@scalius/core/errors";
import { adjustInventory } from "./inventory.service";
import { adjustStock, setStock } from "./stock-adjustment";
import { createPurchaseOrder, markPurchaseOrderOrdered, receivePurchaseOrder } from "./purchase-orders";
import { createTransfer, shipTransfer } from "./transfers";
import { reserveStockBatch } from "./reserve";
import { validateStorefrontCartItems } from "../checkout/cart-validation";
import { createDigitalAsset } from "../digital/assets";
import { importLicenceKeys, listLicenceKeys, revokeLicenceKeys } from "../digital/licence-keys";
import { DIGITAL_STOCK_IS_KEYS_MESSAGE, DIGITAL_STOCK_IS_KEYS_REASON } from "../products/digital-stock-rules";

const CREDENTIAL_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 11)));

let sqlite: DatabaseSync;
let db: Database;
/** Runs once, right before the next writing batch opens its transaction (a concurrent write). */
let race: ((connection: DatabaseSync) => void) | null = null;
let keySeq = 0;
const key = (label: string) => `digital-op-${label}-${String(++keySeq).padStart(6, "0")}`;

const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number | null>) =>
    sqlite.prepare(query).get(...params) as T;
const stock = (variantId: string) => one<{ stock: number }>("SELECT stock FROM product_variants WHERE id = ?", variantId).stock;
const movements = () => one<{ n: number }>("SELECT count(*) AS n FROM inventory_movements").n;

function seedSku(id: string, units: number, kind: "physical" | "digital") {
    sqlite.prepare("INSERT INTO products (id, name, slug, price_minor, is_active) VALUES (?, ?, ?, 90000, 1)")
        .run(`prod_${id}`, `Product ${id}`, `product-${id}`);
    sqlite.prepare(`
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
        VALUES (?, ?, ?, 90000, ?, 0, 1, 1, 1, ?)
    `).run(id, `prod_${id}`, `SKU-${id}`, units, kind);
}

async function expectDigitalError(promise: Promise<unknown>, field?: string) {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe(DIGITAL_STOCK_IS_KEYS_MESSAGE);
    expect((error as ValidationError).details).toMatchObject({ reason: DIGITAL_STOCK_IS_KEYS_REASON, ...(field ? { field } : {}) });
}

beforeEach(() => {
    race = null;
    ({ sqlite, db } = createSqliteD1Database({
        beforeBatch: (connection, statements) => {
            if (!statements.some((statement) => /^\s*(insert|update|delete)\b/i.test(statement.query))) return;
            const write = race;
            race = null;
            write?.(connection);
        },
    }));
    sqlite.prepare("INSERT INTO inventory_locations (id, name, code, kind, is_default, status, position) VALUES ('loc_shop', 'Dhanmondi shop', 'DHN', 'store', 0, 'active', 1)").run();
    seedSku("var_app", 0, "digital");
    seedSku("var_mug", 6, "physical");
});

afterEach(() => sqlite.close());

async function poolWithKeys(count: number): Promise<string> {
    const { asset } = await createDigitalAsset(db, undefined, "prod_var_app", { kind: "licence_keys", variantId: "var_app" });
    await importLicenceKeys(db, {
        assetId: asset.id,
        keys: Array.from({ length: count }, (_, index) => `APP-KEY-${index}`),
        requestKey: crypto.randomUUID(),
        credentialKey: CREDENTIAL_KEY,
    });
    return asset.id;
}

describe("digital stock rules on inventory paths", () => {
    it("key import and revoke still move a digital SKU's stock (pool = stock)", async () => {
        const assetId = await poolWithKeys(3);
        expect(stock("var_app")).toBe(3);
        const keys = await listLicenceKeys(db, { assetId, status: "available" });
        await revokeLicenceKeys(db, { assetId, keyIds: [keys.items[0]!.id], requestKey: crypto.randomUUID() });
        expect(stock("var_app")).toBe(2);
        await importLicenceKeys(db, { assetId, keys: ["APP-KEY-NEW"], requestKey: crypto.randomUUID(), credentialKey: CREDENTIAL_KEY });
        expect(stock("var_app")).toBe(3);
        expect(one("SELECT count(*) AS n FROM inventory_operations WHERE operation_type = 'licence_keys'")).toEqual({ n: 3 });
    });

    it("starts tracking a file-only SKU at its first key pool: its keys become its stock", async () => {
        sqlite.prepare("UPDATE product_variants SET track_inventory = 0 WHERE id = 'var_app'").run();
        const assetId = await poolWithKeys(2);
        expect(one("SELECT track_inventory AS t, stock FROM product_variants WHERE id = 'var_app'")).toEqual({ t: 1, stock: 2 });
        expect(one<{ status: string }>("SELECT status FROM digital_assets WHERE id = ?", assetId).status).toBe("ready");

        // An untracked SKU that still shows an old quantity is not tracked behind the merchant's back.
        seedSku("var_old", 4, "digital");
        sqlite.prepare("UPDATE product_variants SET track_inventory = 0 WHERE id = 'var_old'").run();
        const refused = await createDigitalAsset(db, undefined, "prod_var_old", { kind: "licence_keys", variantId: "var_old" })
            .then(() => null, (error: unknown) => error);
        expect(refused).toBeInstanceOf(ValidationError);
        expect(one("SELECT count(*) AS n FROM digital_assets WHERE variant_id = 'var_old'")).toEqual({ n: 0 });
    });

    it("never sells more of a key-delivered SKU than its unused keys, even when an old typed quantity outgrew them", async () => {
        await poolWithKeys(2);
        // A quantity typed in before stock became the keys (stock 5, 2 keys).
        sqlite.prepare("UPDATE product_variants SET stock = 5 WHERE id = 'var_app'").run();
        const line = (quantity: number) => [{ productId: "prod_var_app", variantId: "var_app", quantity }];

        const over = await validateStorefrontCartItems(db, line(3));
        expect(over.issues).toEqual([expect.objectContaining({ code: "QUANTITY_UNAVAILABLE", availableQuantity: 2 })]);
        expect((await validateStorefrontCartItems(db, line(2))).valid).toBe(true);

        // The reservation itself refuses a third key (the batch guard), and takes two.
        const before = movements();
        expect(await reserveStockBatch(db, [{ variantId: "var_app", quantity: 3, orderId: "order_over" }], "regular", { salesChannelId: "sc_online_store" }))
            .toMatchObject({ success: false });
        expect(one("SELECT reserved_stock AS r FROM product_variants WHERE id = 'var_app'")).toEqual({ r: 0 });
        expect(movements()).toBe(before);
        expect(await reserveStockBatch(db, [{ variantId: "var_app", quantity: 2, orderId: "order_ok" }], "regular", { salesChannelId: "sc_online_store" }))
            .toMatchObject({ success: true });
        expect(one("SELECT reserved_stock AS r FROM product_variants WHERE id = 'var_app'")).toEqual({ r: 2 });
    });

    it("refuses manual adjustments, scanner adjustments and counts that change a digital SKU", async () => {
        await poolWithKeys(3);
        const before = movements();
        await expectDigitalError(adjustInventory(db, "var_app", { operationKey: key("manual"), delta: 2, reason: "correction" }));
        await expectDigitalError(adjustInventory(db, "var_app", { operationKey: key("pre"), delta: 2, reason: "other", pool: "preorderStock" }));
        await expectDigitalError(adjustStock(db, "var_app", -1, key("scan")));
        await expectDigitalError(setStock(db, "var_app", 7, key("count")));
        await expectDigitalError(setStock(db, "var_app", 0, key("zero"), undefined, undefined, "loc_default"));
        expect(stock("var_app")).toBe(3);
        expect(movements()).toBe(before);
        expect(one("SELECT count(*) AS n FROM inventory_operations WHERE operation_type <> 'licence_keys'")).toEqual({ n: 0 });

        // A count that matches the keys changes nothing and is fine.
        expect(await setStock(db, "var_app", 3, key("match"))).toMatchObject({ previousStock: 3, newStock: 3, delta: 0 });
        expect(movements()).toBe(before);

        // Physical SKUs are untouched by the rule.
        expect(await adjustStock(db, "var_mug", 2, key("mug"))).toMatchObject({ previousStock: 6, newStock: 8 });
    });

    it("refuses an adjustment when the SKU turned digital after the read (batch guard)", async () => {
        race = (connection) => connection.prepare("UPDATE product_variants SET fulfillment_kind = 'digital' WHERE id = 'var_mug'").run();
        await expectDigitalError(adjustInventory(db, "var_mug", { operationKey: key("raced"), delta: 1, reason: "received" }));
        expect(stock("var_mug")).toBe(6);
        expect(one("SELECT count(*) AS n FROM inventory_operations")).toEqual({ n: 0 });
    });

    it("refuses a digital SKU as a purchase order or transfer line", async () => {
        await expectDigitalError(createPurchaseOrder(db, { lines: [
            { variantId: "var_mug", quantity: 1, unitCost: 10 },
            { variantId: "var_app", quantity: 5, unitCost: 10 },
        ] }), "lines.1.variantId");
        await expectDigitalError(createTransfer(db, {
            originLocationId: "loc_default", destinationLocationId: "loc_shop", lines: [{ variantId: "var_app", quantity: 1 }],
        }), "lines.0.variantId");
        expect(one("SELECT count(*) AS n FROM purchase_orders")).toEqual({ n: 0 });
    });

    it("refuses receiving or shipping a line whose SKU turned digital since it was added", async () => {
        const order = await createPurchaseOrder(db, { lines: [{ variantId: "var_mug", quantity: 4, unitCost: 10 }] });
        const ordered = await markPurchaseOrderOrdered(db, order.id, 1);
        const transfer = await createTransfer(db, {
            originLocationId: "loc_default", destinationLocationId: "loc_shop", lines: [{ variantId: "var_mug", quantity: 2 }],
        });
        sqlite.prepare("UPDATE product_variants SET fulfillment_kind = 'digital' WHERE id = 'var_mug'").run();
        const before = movements();
        await expectDigitalError(receivePurchaseOrder(db, order.id, { operationKey: key("receive"), lines: [{ lineId: ordered.lines[0]!.id, quantity: 4 }] }));
        await expectDigitalError(shipTransfer(db, transfer.id, { operationKey: key("ship"), expectedRevision: 1 }));
        expect(stock("var_mug")).toBe(6);
        expect(movements()).toBe(before);
    });

    it("refuses a receipt when the SKU turns digital while it commits (CAS guard, re-planned)", async () => {
        const order = await createPurchaseOrder(db, { lines: [{ variantId: "var_mug", quantity: 4, unitCost: 10 }] });
        const ordered = await markPurchaseOrderOrdered(db, order.id, 1);
        race = (connection) => connection.prepare("UPDATE product_variants SET fulfillment_kind = 'digital' WHERE id = 'var_mug'").run();
        await expectDigitalError(receivePurchaseOrder(db, order.id, { operationKey: key("raced"), lines: [{ lineId: ordered.lines[0]!.id, quantity: 4 }] }));
        expect(stock("var_mug")).toBe(6);
        expect(one("SELECT count(*) AS n FROM inventory_commands")).toEqual({ n: 0 });
    });
});
