// D8 seam (Wave B §3.1): a digital line is orderable only when a digital
// fulfiller exists AND its variant is deliverable (the readiness column in
// the existing variant read). Both are false in B0, so digital fails closed.
import type { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

const seams = vi.hoisted(() => ({ digitalFulfiller: false, deliverable: false }));

vi.mock("../fulfilment/registry", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../fulfilment/registry")>();
    return {
        ...actual,
        hasFulfiller: (type: Parameters<typeof actual.hasFulfiller>[0]) =>
            type === "digital" ? seams.digitalFulfiller : actual.hasFulfiller(type),
    };
});
vi.mock("../digital/deliverable", () => ({
    digitalDeliverableSql: () => (seams.deliverable ? sql`1` : sql`0`),
}));

const { validateStorefrontCartItems } = await import("./cart-validation");

describe("digital readiness in cart validation", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(() => {
        seams.digitalFulfiller = false;
        seams.deliverable = false;
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO products (id, name, slug, price_minor, is_active) VALUES
              ('p_dig', 'E-book', 'ebook', 20000, 1),
              ('p_mug', 'Mug', 'mug', 30000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
            VALUES
              ('v_dig', 'p_dig', 'EBOOK-1', 20000, 0, 0, 0, 1, 0, 'digital'),
              ('v_mug', 'p_mug', 'MUG-1', 30000, 5, 0, 0, 1, 1, 'physical');
        `);
    });

    afterEach(() => sqlite.close());

    const digitalLine = [{ productId: "p_dig", variantId: "v_dig", quantity: 1 }];
    const codes = async () => (await validateStorefrontCartItems(db, digitalLine)).issues.map((issue) => issue.code);

    it("fails closed without a fulfiller or without something to deliver", async () => {
        expect(await codes()).toEqual(["FULFILMENT_UNAVAILABLE"]);

        seams.digitalFulfiller = true;
        expect(await codes()).toEqual(["FULFILMENT_UNAVAILABLE"]);

        seams.digitalFulfiller = false;
        seams.deliverable = true;
        expect(await codes()).toEqual(["FULFILMENT_UNAVAILABLE"]);

        seams.digitalFulfiller = true;
        const validation = await validateStorefrontCartItems(db, digitalLine);
        expect(validation.valid).toBe(true);
        expect(validation.items).toEqual([expect.objectContaining({ fulfillmentKind: "digital" })]);
    });

    it("leaves physical lines alone: readiness only gates digital SKUs", async () => {
        const validation = await validateStorefrontCartItems(db, [{ productId: "p_mug", variantId: "v_mug", quantity: 1 }]);
        expect(validation.valid).toBe(true);
    });
});
