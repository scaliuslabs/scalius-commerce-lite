// Digital goods on the real migrated schema (Wave B §3.6): delivery only after
// settlement (D1), a key assigned at most once and an all-or-nothing delivery
// when a pool is short (D2), pool = stock through ledger-v2 edges (D3), the
// download count never passing its limit under concurrent mints (D4), and
// tickets bound to the buyer's proof (D5). Keys are encrypted at rest (D7).
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { autoFulfilOrder, listOrdersAwaitingAutoFulfil } from "../fulfilment/auto-fulfil";
import { buildFulfilmentInsertStatements } from "../fulfilment/ledger";
import { validateStorefrontCartItems } from "../checkout/cart-validation";
import { planDigitalDelivery } from "./fulfiller";
import { importLicenceKeys, listLicenceKeys, revokeLicenceKeys } from "./licence-keys";
import { listBuyerDownloads, mintDownloadTicket, openDownloadTicket, revealLicenceKey } from "./downloads";
import { resetDigitalEntitlement, resolveDigitalDeliveryContent, revokeDigitalEntitlement } from "./entitlements";
import { countBuyerDownloads, listLineDeliveries } from "./extras";
import { updateDigitalAsset } from "./assets";

const CREDENTIAL_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 7)));
const ENV = { SCALIUS_SECRET: "test-master-secret-for-digital-downloads-0123456789" };
const PROOF = "rcpt_proof_for_the_buyer_cookie_0001";

describe("digital goods", () => {
    let sqlite: DatabaseSync;
    let db: Database;
    const one = <T = Record<string, unknown>>(query: string) => sqlite.prepare(query).get() as T;
    const all = <T = Record<string, unknown>>(query: string) => sqlite.prepare(query).all() as T[];

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO customers (id, name, phone) VALUES ('cus_1', 'Buyer', '+8801700000000');
            INSERT INTO products (id, name, slug, price_minor, is_active) VALUES
              ('p_book', 'E-book', 'ebook', 50000, 1),
              ('p_app', 'App licence', 'app', 90000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
            VALUES
              ('v_book', 'p_book', 'EBOOK', 50000, 0, 0, 0, 1, 0, 'digital'),
              ('v_app', 'p_app', 'APP-1', 90000, 0, 0, 0, 1, 1, 'digital');
            INSERT INTO digital_assets (id, product_id, variant_id, kind, status, display_name, filename, media_type, size_bytes, current_r2_key, download_limit)
            VALUES ('dga_book_file_01', 'p_book', NULL, 'file', 'ready', 'The book (PDF)', 'book.pdf', 'application/pdf', 1000,
              'private/digital/dga_book_file_01/dgu_1', 5);
            INSERT INTO digital_assets (id, product_id, variant_id, kind, status, display_name, download_limit)
            VALUES ('dga_app_pool_001', 'p_app', 'v_app', 'licence_keys', 'ready', 'Licence key', NULL);
        `);
    });

    afterEach(() => sqlite.close());

    function order(id: string, lines: Array<{ item: string; product: string; variant: string; quantity: number }>, paid = true) {
        sqlite.exec(`
            INSERT INTO orders (id, customer_name, customer_phone, requires_shipping, currency_code, currency_decimal_places,
              subtotal_amount_minor, total_amount_minor, status, payment_method, payment_status, paid_amount_minor, balance_due_minor,
              fulfillment_status, inventory_pool, inventory_action, version, account_owner_customer_id)
            VALUES ('${id}', 'Buyer', '+8801700000000', 0, 'BDT', 2, 50000, 50000, 'pending', 'stripe',
              '${paid ? "paid" : "unpaid"}', ${paid ? 50000 : 0}, ${paid ? 0 : 50000}, 'pending', 'regular', 'none', 1, 'cus_1');
        `);
        for (const line of lines) {
            sqlite.exec(`
                INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, inventory_tracked,
                  unit_price_minor, line_subtotal_minor, discount_amount_minor, taxable_amount_minor, tax_amount_minor, fulfillment_type)
                VALUES ('${line.item}', '${id}', '${line.product}', '${line.variant}', ${line.quantity}, 'Item', 0, 50000, 50000, 0, 0, 0, 'digital');
            `);
        }
    }

    const importKeys = (keys: string[], requestKey = crypto.randomUUID()) =>
        importLicenceKeys(db, { assetId: "dga_app_pool_001", keys, requestKey, credentialKey: CREDENTIAL_KEY });

    it("D3: an import adds encrypted keys and the same number of stock units in one ledger-v2 edge, idempotently", async () => {
        const requestKey = crypto.randomUUID();
        const first = await importKeys(["AAAA-1111", "BBBB-2222", "AAAA-1111", "CCCC-3333"], requestKey);
        expect(first).toMatchObject({ imported: 3, alreadyInPool: 0, replayed: false, previousStock: 0, stock: 3 });
        expect(first.rejected).toEqual([{ line: 3, reason: "duplicate" }]);
        expect(one("SELECT stock, stock_version FROM product_variants WHERE id = 'v_app'")).toEqual({ stock: 3, stock_version: 1 });
        const operation = one<{ operation_type: string; movement_id: string }>("SELECT operation_type, movement_id FROM inventory_operations");
        expect(operation.operation_type).toBe("licence_keys");
        expect(one(`SELECT quantity FROM inventory_movements WHERE id = '${operation.movement_id}'`)).toEqual({ quantity: 3 });
        // Encrypted at rest; only the last characters are readable.
        const stored = all<{ key_ciphertext: string; key_last4: string }>("SELECT key_ciphertext, key_last4 FROM digital_licence_keys ORDER BY id");
        expect(stored.map((row) => row.key_last4)).toEqual(["1111", "2222", "3333"]);
        expect(stored.every((row) => row.key_ciphertext.startsWith("v1:") && !row.key_ciphertext.includes("AAAA"))).toBe(true);

        // Same request key: a replay, nothing added. New request with known keys: skipped by hash.
        expect(await importKeys(["AAAA-1111", "BBBB-2222", "CCCC-3333"], requestKey)).toMatchObject({ replayed: true, imported: 3, stock: 3 });
        expect(await importKeys(["BBBB-2222", "DDDD-4444"])).toMatchObject({ imported: 1, alreadyInPool: 1, stock: 4 });
        expect(one("SELECT count(*) AS n FROM digital_licence_keys")).toEqual({ n: 4 });

        // Revoking unused keys removes them from the pool and the stock together.
        const keys = await listLicenceKeys(db, { assetId: "dga_app_pool_001", status: "available" });
        const revoked = await revokeLicenceKeys(db, { assetId: "dga_app_pool_001", keyIds: [keys.items[0]!.id], requestKey: crypto.randomUUID() });
        expect(revoked).toMatchObject({ revoked: 1, previousStock: 4, stock: 3 });
        expect(one("SELECT count(*) AS n FROM digital_licence_keys WHERE status = 'available'")).toEqual({ n: 3 });
        expect(one("SELECT count(*) AS n FROM inventory_operations WHERE operation_type = 'licence_keys'")).toEqual({ n: 3 });
    });

    it("D3: keys never commit without their stock edge (a missing credential key refuses before any write)", async () => {
        await expect(importLicenceKeys(db, { assetId: "dga_app_pool_001", keys: ["X-1"], requestKey: crypto.randomUUID(), credentialKey: undefined }))
            .rejects.toMatchObject({ status: 503 });
        expect(one("SELECT count(*) AS n FROM digital_licence_keys")).toEqual({ n: 0 });
        expect(one("SELECT stock FROM product_variants WHERE id = 'v_app'")).toEqual({ stock: 0 });
    });

    it("D1: files and keys are delivered only after settlement, once, with the delivery message", async () => {
        await importKeys(["KEY-A-0001", "KEY-B-0002", "KEY-C-0003"]);
        order("o_1", [
            { item: "i_book", product: "p_book", variant: "v_book", quantity: 1 },
            { item: "i_app", product: "p_app", variant: "v_app", quantity: 2 },
        ], false);
        expect(await autoFulfilOrder(db, "o_1")).toMatchObject({ skipped: "unsettled" });
        expect(one("SELECT count(*) AS n FROM digital_entitlements")).toEqual({ n: 0 });

        sqlite.exec(`UPDATE orders SET payment_status = 'paid', paid_amount_minor = 50000, balance_due_minor = 0 WHERE id = 'o_1'`);
        expect(await autoFulfilOrder(db, "o_1")).toMatchObject({ fulfilledTypes: ["digital"], delivered: true });
        expect(await autoFulfilOrder(db, "o_1")).toMatchObject({ skipped: "no_auto_lines", fulfilledTypes: [] });
        expect(all("SELECT order_item_id, kind, quantity, download_limit FROM digital_entitlements ORDER BY order_item_id")).toEqual([
            { order_item_id: "i_app", kind: "licence_keys", quantity: 2, download_limit: null },
            { order_item_id: "i_book", kind: "file", quantity: 1, download_limit: 5 },
        ]);
        // FIFO: the first two keys imported.
        expect(all("SELECT key_last4 FROM digital_licence_keys WHERE status = 'assigned' ORDER BY id")).toEqual([{ key_last4: "0001" }, { key_last4: "0002" }]);
        const outbox = one<{ notification_type: string; payload: string }>("SELECT notification_type, payload FROM notification_outbox WHERE audience = 'customer'");
        expect(outbox.notification_type).toBe("order_digital_delivered");
        expect(outbox.payload).not.toMatch(/KEY-|book\.pdf/);
        expect(one("SELECT status FROM orders WHERE id = 'o_1'")).toEqual({ status: "delivered" });

        // Send-time content: file names and the plaintext keys, decrypted now.
        expect(await resolveDigitalDeliveryContent(db, CREDENTIAL_KEY, { orderId: "o_1" })).toEqual({
            fileNames: ["The book (PDF)"],
            licenceKeys: ["KEY-A-0001", "KEY-B-0002"],
        });
        const extras = await listLineDeliveries(db, { orderId: "o_1", orderItemIds: ["i_book", "i_app"], audience: "buyer" });
        expect(extras.get("i_app")?.licenceKeys.map((key) => key.last4)).toEqual(["0001", "0002"]);
        expect(extras.get("i_book")?.downloads).toEqual([expect.objectContaining({ displayName: "The book (PDF)", downloadCount: 0, downloadLimit: 5, revoked: false })]);
    });

    it("D2: a key is assigned at most once; concurrent deliveries on a pool of 3 with demand 4 deliver one order and roll the other back", async () => {
        await importKeys(["K-1", "K-2", "K-3"].map((key) => `${key}-XYZW`));
        order("o_a", [{ item: "i_a", product: "p_app", variant: "v_app", quantity: 2 }]);
        order("o_b", [{ item: "i_b", product: "p_app", variant: "v_app", quantity: 2 }]);
        // Both plans read 3 available keys before either batch runs (the race).
        const delivery = async (orderId: string, orderItemId: string) => {
            const lines = [{ orderItemId, productId: "p_app", variantId: "v_app", quantity: 2 }];
            const fulfillmentId = `ful_${orderId}`;
            const plan = await planDigitalDelivery(db, { orderId, fulfillmentId, lines });
            expect(plan.shortPools).toEqual([]);
            return [
                ...buildFulfilmentInsertStatements(db, { fulfillmentId, orderId, kind: "digital", requestKey: "auto:digital", actor: { type: "system", id: null }, lines }),
                ...plan.statements,
            ];
        };
        const batchA = await delivery("o_a", "i_a");
        const batchB = await delivery("o_b", "i_b");
        const results = await Promise.allSettled([safeBatch(db, batchA), safeBatch(db, batchB)]);
        expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/DIGITAL_KEYS_EXHAUSTED|malformed JSON/i);
        // Nothing half-delivered: exactly one entitlement and its two keys; the third key is still free.
        expect(one("SELECT count(*) AS n FROM digital_entitlements")).toEqual({ n: 1 });
        expect(one("SELECT count(*) AS n FROM order_fulfillments")).toEqual({ n: 1 });
        expect(all("SELECT status, count(*) AS n FROM digital_licence_keys GROUP BY status ORDER BY status")).toEqual([
            { status: "assigned", n: 2 },
            { status: "available", n: 1 },
        ]);
        // Assignment is final (trigger): no key moves back or to another line.
        expect(() => sqlite.exec("UPDATE digital_licence_keys SET status = 'available', order_item_id = NULL, entitlement_id = NULL, assigned_at = NULL WHERE status = 'assigned'"))
            .toThrow(/licence keys only move/);
    });

    it("D2: an empty pool delivers nothing, alerts staff once a day, and the sweep delivers after an import", async () => {
        await importKeys(["ONLY-0001"]);
        order("o_short", [
            { item: "i_file", product: "p_book", variant: "v_book", quantity: 1 },
            { item: "i_keys", product: "p_app", variant: "v_app", quantity: 2 },
        ]);
        await expect(autoFulfilOrder(db, "o_short")).rejects.toThrow(/DIGITAL_KEYS_EXHAUSTED/);
        await expect(autoFulfilOrder(db, "o_short")).rejects.toThrow(/DIGITAL_KEYS_EXHAUSTED/);
        expect(one("SELECT count(*) AS n FROM order_fulfillments")).toEqual({ n: 0 });
        expect(one("SELECT count(*) AS n FROM digital_entitlements")).toEqual({ n: 0 });
        expect(one("SELECT count(*) AS n FROM digital_licence_keys WHERE status = 'assigned'")).toEqual({ n: 0 });
        expect(all("SELECT notification_type, audience FROM notification_outbox")).toEqual([
            { notification_type: "digital_keys_exhausted", audience: "staff" },
        ]);
        expect(await listOrdersAwaitingAutoFulfil(db)).toEqual(["o_short"]);

        await importKeys(["NEXT-0002"]);
        expect(await autoFulfilOrder(db, "o_short")).toMatchObject({ fulfilledTypes: ["digital"], delivered: true });
        expect(one("SELECT count(*) AS n FROM digital_licence_keys WHERE status = 'assigned' AND order_item_id = 'i_keys'")).toEqual({ n: 2 });
        expect(await listOrdersAwaitingAutoFulfil(db)).toEqual([]);
    });

    it("D8: a digital SKU is orderable only while something is ready to deliver", async () => {
        const codes = async (variant: string, product: string) =>
            (await validateStorefrontCartItems(db, [{ productId: product, variantId: variant, quantity: 1 }])).issues.map((issue) => issue.code);
        expect(await codes("v_book", "p_book")).toEqual([]);
        // An empty key pool: not deliverable (and out of stock).
        expect(await codes("v_app", "p_app")).toContain("FULFILMENT_UNAVAILABLE");
        await importKeys(["READY-0001"]);
        expect(await codes("v_app", "p_app")).toEqual([]);
        // An archived file: nothing to deliver.
        await updateDigitalAsset(db, "dga_book_file_01", { status: "archived", version: 1 });
        expect(await codes("v_book", "p_book")).toEqual(["FULFILMENT_UNAVAILABLE"]);
    });

    it("D4: ten concurrent mints on a limit of 5 count exactly five downloads", async () => {
        order("o_dl", [{ item: "i_dl", product: "p_book", variant: "v_book", quantity: 1 }]);
        await autoFulfilOrder(db, "o_dl");
        const entitlementId = one<{ id: string }>("SELECT id FROM digital_entitlements").id;
        const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
            mintDownloadTicket(db, ENV, { entitlementId, access: { kind: "receipt", orderId: "o_dl" }, proof: PROOF })));
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
        expect(results.filter((result) => result.status === "rejected").every((result) =>
            (result as PromiseRejectedResult).reason.code === "DOWNLOAD_LIMIT_REACHED")).toBe(true);
        expect(one("SELECT download_count FROM digital_entitlements")).toEqual({ download_count: 5 });

        await resetDigitalEntitlement(db, entitlementId);
        await expect(mintDownloadTicket(db, ENV, { entitlementId, access: { kind: "receipt", orderId: "o_dl" }, proof: PROOF })).resolves.toMatchObject({ downloadCount: 1 });
    });

    it("D5: a ticket opens only with the proof it was minted for, before it expires, while access lasts", async () => {
        order("o_t", [{ item: "i_t", product: "p_book", variant: "v_book", quantity: 1 }]);
        order("o_other", [{ item: "i_o", product: "p_book", variant: "v_book", quantity: 1 }]);
        await autoFulfilOrder(db, "o_t");
        const entitlementId = one<{ id: string }>("SELECT id FROM digital_entitlements WHERE order_id = 'o_t'").id;
        // Access follows the order: another order's receipt can't mint it.
        await expect(mintDownloadTicket(db, ENV, { entitlementId, access: { kind: "receipt", orderId: "o_other" }, proof: PROOF }))
            .rejects.toMatchObject({ status: 404 });
        const now = 1_900_000_000;
        const ticket = await mintDownloadTicket(db, ENV, { entitlementId, access: { kind: "customer", customerId: "cus_1" }, proof: PROOF }, now);
        const [, exp, sig] = ticket.path.split("/");
        const open = (proof: string | null, at = now + 5) =>
            openDownloadTicket(db, ENV, { entitlementId, expiresAt: Number(exp), signature: sig!, proof }, at);
        await expect(open(PROOF)).resolves.toMatchObject({ r2Key: "private/digital/dga_book_file_01/dgu_1", filename: "book.pdf" });
        await expect(open(null)).rejects.toMatchObject({ status: 404 });
        await expect(open("someone-elses-cookie")).rejects.toMatchObject({ status: 404 });
        await expect(open(PROOF, now + 601)).rejects.toMatchObject({ status: 404 });
        await expect(openDownloadTicket(db, { SCALIUS_SECRET: "another-store-secret-0123456789abcdefghijkl" },
            { entitlementId, expiresAt: Number(exp), signature: sig!, proof: PROOF }, now + 5)).rejects.toMatchObject({ status: 404 });

        await revokeDigitalEntitlement(db, entitlementId);
        await expect(open(PROOF)).rejects.toMatchObject({ status: 404 });
        await expect(mintDownloadTicket(db, ENV, { entitlementId, access: { kind: "customer", customerId: "cus_1" }, proof: PROOF }))
            .rejects.toMatchObject({ code: "DOWNLOAD_REVOKED" });
    });

    it("a cancelled or refunded order ends access to its downloads and keys", async () => {
        await importKeys(["ENDS-KEY-0001"]);
        order("o_end", [
            { item: "i_end_file", product: "p_book", variant: "v_book", quantity: 1 },
            { item: "i_end_key", product: "p_app", variant: "v_app", quantity: 1 },
        ]);
        await autoFulfilOrder(db, "o_end");
        const entitlementId = one<{ id: string }>("SELECT id FROM digital_entitlements WHERE kind = 'file'").id;
        const keyId = one<{ id: string }>("SELECT id FROM digital_licence_keys").id;
        const now = 1_900_000_000;
        const ticket = await mintDownloadTicket(db, ENV, { entitlementId, access: { kind: "receipt", orderId: "o_end" }, proof: PROOF }, now);
        const [, exp, sig] = ticket.path.split("/");
        expect(await countBuyerDownloads(db, "cus_1")).toBe(2);

        sqlite.exec("UPDATE orders SET status = 'refunded' WHERE id = 'o_end'");
        await expect(openDownloadTicket(db, ENV, { entitlementId, expiresAt: Number(exp), signature: sig!, proof: PROOF }, now + 5))
            .rejects.toMatchObject({ status: 404 });
        await expect(mintDownloadTicket(db, ENV, { entitlementId, access: { kind: "receipt", orderId: "o_end" }, proof: PROOF }))
            .rejects.toMatchObject({ code: "DOWNLOAD_REVOKED" });
        await expect(revealLicenceKey(db, CREDENTIAL_KEY, { keyId, access: { kind: "receipt", orderId: "o_end" } }))
            .rejects.toMatchObject({ status: 404 });
        expect(await countBuyerDownloads(db, "cus_1")).toBe(0);
        const [line] = (await listBuyerDownloads(db, { kind: "receipt", orderId: "o_end" })).filter((entry) => entry.orderItemId === "i_end_file");
        expect(line?.files[0]).toMatchObject({ revoked: true, available: false });
        const extras = await listLineDeliveries(db, { orderId: "o_end", orderItemIds: ["i_end_file", "i_end_key"], audience: "buyer" });
        expect(extras.get("i_end_file")?.downloads[0]?.revoked).toBe(true);
        expect(extras.get("i_end_key")?.licenceKeys ?? []).toEqual([]);
        expect(await resolveDigitalDeliveryContent(db, CREDENTIAL_KEY, { orderId: "o_end" })).toBeNull();
    });

    it("reveals a key only to the buyer of its line, and lists the account's downloads", async () => {
        await importKeys(["SECRET-KEY-9876"]);
        order("o_k", [{ item: "i_k", product: "p_app", variant: "v_app", quantity: 1 }]);
        order("o_x", [{ item: "i_x", product: "p_book", variant: "v_book", quantity: 1 }], false);
        await autoFulfilOrder(db, "o_k");
        const keyId = one<{ id: string }>("SELECT id FROM digital_licence_keys").id;
        await expect(revealLicenceKey(db, CREDENTIAL_KEY, { keyId, access: { kind: "receipt", orderId: "o_k" } }))
            .resolves.toEqual({ keyId, key: "SECRET-KEY-9876", last4: "9876" });
        await expect(revealLicenceKey(db, CREDENTIAL_KEY, { keyId, access: { kind: "receipt", orderId: "o_x" } }))
            .rejects.toMatchObject({ status: 404 });
        await expect(revealLicenceKey(db, CREDENTIAL_KEY, { keyId, access: { kind: "customer", customerId: "cus_other" } }))
            .rejects.toMatchObject({ status: 404 });
        await expect(revealLicenceKey(db, undefined, { keyId, access: { kind: "customer", customerId: "cus_1" } }))
            .rejects.toMatchObject({ status: 503 });

        const lines = await listBuyerDownloads(db, { kind: "customer", customerId: "cus_1" });
        expect(lines).toEqual([expect.objectContaining({ orderId: "o_k", orderItemId: "i_k", files: [], licenceKeys: [{ keyId, last4: "9876" }] })]);
    });
});
