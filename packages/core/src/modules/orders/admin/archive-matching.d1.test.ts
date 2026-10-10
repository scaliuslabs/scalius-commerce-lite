import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { archiveOrders } from "./archive";
import { listMatchingArchivableOrders } from "./list";

const harnesses: Array<{ sqlite: { close(): void } }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

/** 250 orders: every other one delivered, the rest pending; every fifth paid by card. */
function setup() {
    const harness = createSqliteD1Database();
    harnesses.push(harness);
    const insert = harness.sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor, shipping_amount_minor, status, payment_method)
        VALUES (?, 'Buyer', '+8801700000009', 'Address', 'city', 'zone', 1000, 0, ?, ?)`);
    harness.sqlite.exec("BEGIN");
    for (let index = 0; index < 250; index += 1) {
        insert.run(`ord_${String(index).padStart(4, "0")}`, index % 2 === 0 ? "delivered" : "pending", index % 5 === 0 ? "stripe" : "cod");
    }
    harness.sqlite.exec("COMMIT");
    return harness;
}

describe("archive all matching orders (T11)", () => {
    it("walks only the finished orders the filter matches and archives each slice, whatever the count", async () => {
        const { db } = setup();
        const archived: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 100; guard += 1) {
            const slice = await listMatchingArchivableOrders(db, { paymentMethod: "cod" }, cursor, 8);
            expect(slice.claims.length).toBeLessThanOrEqual(8);
            if (slice.claims.length > 0) await archiveOrders(db, slice.claims);
            archived.push(...slice.claims.map((claim) => claim.id));
            if (!slice.next) break;
            cursor = slice.next;
        }
        // Delivered (even index) and paid on delivery (index not a multiple of 5): 125 - 25.
        expect(archived).toHaveLength(100);
        expect(new Set(archived).size).toBe(100);
        // Archived orders left the list; nothing is left to walk.
        expect((await listMatchingArchivableOrders(db, { paymentMethod: "cod" }, undefined)).claims).toEqual([]);
        // Pending orders were never read.
        expect(archived.every((id) => Number(id.slice(4)) % 2 === 0)).toBe(true);
    });
});
