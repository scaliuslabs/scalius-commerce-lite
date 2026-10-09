import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { bulkDeleteCustomers, bulkRestoreCustomers, listMatchingCustomerIds } from "./customers.service";

const harnesses: Array<{ sqlite: { close(): void } }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

function setup(count: number) {
    const harness = createSqliteD1Database();
    harnesses.push(harness);
    const insert = harness.sqlite.prepare("INSERT INTO customers (id, name, phone) VALUES (?, ?, ?)");
    harness.sqlite.exec("BEGIN");
    for (let index = 0; index < count; index += 1) {
        insert.run(`cus_${String(index).padStart(4, "0")}`, index % 2 === 0 ? `Rahim ${index}` : `Karim ${index}`, `+88017${String(10_000_000 + index)}`);
    }
    // Two customers with an order: never deleted for good.
    harness.sqlite.exec(`
        INSERT INTO orders (id, customer_id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor, shipping_amount_minor)
        VALUES ('ord_1', 'cus_0002', 'Rahim 2', '+8801710000002', 'Address', 'city', 'zone', 1000, 0),
               ('ord_2', 'cus_0004', 'Rahim 4', '+8801710000004', 'Address', 'city', 'zone', 1000, 0);
    `);
    harness.sqlite.exec("COMMIT");
    return harness;
}

async function walk(read: (cursor: string | undefined) => Promise<{ ids: string[]; next: string | null }>) {
    const all: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 1_000; guard += 1) {
        const slice = await read(cursor);
        all.push(...slice.ids);
        if (!slice.next) return all;
        cursor = slice.next;
    }
    throw new Error("the walk never ended");
}

describe("all matching customers (select all N, T11)", () => {
    it("trashes, restores and deletes every customer a search matches, slice by slice", async () => {
        const { db } = setup(300);
        const trashed = await walk(async (cursor) => {
            const slice = await listMatchingCustomerIds(db, { search: "Rahim" }, cursor);
            if (slice.ids.length > 0) await bulkDeleteCustomers(db, slice.ids, false);
            return slice;
        });
        expect(trashed).toHaveLength(150);
        expect((await listMatchingCustomerIds(db, { search: "Rahim" }, undefined)).ids).toEqual([]);
        expect((await listMatchingCustomerIds(db, { search: "Karim" }, undefined)).ids).toHaveLength(90);

        // A permanent delete reads only customers without orders, so the walk never stalls on them.
        const deleted = await walk(async (cursor) => {
            const slice = await listMatchingCustomerIds(db, { showTrashed: true }, cursor, 90, { deletableOnly: true });
            if (slice.ids.length > 0) await bulkDeleteCustomers(db, slice.ids, true);
            return slice;
        });
        expect(deleted).toHaveLength(148);
        const kept = await listMatchingCustomerIds(db, { showTrashed: true }, undefined);
        expect(kept.ids).toEqual(["cus_0002", "cus_0004"]);

        const { restored, blocked } = await bulkRestoreCustomers(db, kept.ids);
        expect(restored).toEqual(["cus_0002", "cus_0004"]);
        expect(blocked).toEqual([]);
    });
});
