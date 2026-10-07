// PostgreSQL parity for the reads reshaped to D1's limits: the LIKE-free text
// matches (instr/substr; the PostgreSQL profile defines instr) and the admin
// order detail read in two statements. Opt-in: point SCALIUS_TEST_POSTGRES_URL
// at a disposable server; the test creates and drops its own database.
import { afterAll, describe, expect, it } from "vitest";
import { categories } from "@scalius/database/schema";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";

import { getOrderDetails } from "../modules/orders";
import { containsText, handleOrNumberedCopy, startsWithText } from "./text-match";

const postgresUrl = nativePostgresUrl();

afterAll(closeNativePostgres);

describe.runIf(postgresUrl)("D1-shaped reads on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
    it("matches text literally, ignoring case, at any length", async () => {
        const { db, client } = await createNativePostgres({ label: "text_match" });
        const longBangla = "হাতে বোনা জামদানি শাড়ি উৎসব সংস্করণ";
        await client.query(`INSERT INTO categories (id, name, slug) VALUES
            ('cat_a', 'Summer 100% cotton_tees', 'summer-cotton-tees'),
            ('cat_b', 'Summer 100x cottonXtees', 'summer-cotton-tees-2'),
            ('cat_c', $1, 'summer-cotton-tees-extra'),
            ('cat_d', 'Winter', 'summer-cotton-teesx')`, [`${longBangla} ও আরও`]);
        const ids = async (where: ReturnType<typeof containsText>) =>
            (await db.select({ id: categories.id }).from(categories).where(where).orderBy(categories.id)).map((row) => row.id);

        expect(await ids(containsText(categories.name, longBangla))).toEqual(["cat_c"]);
        expect(await ids(containsText(categories.name, "100% COTTON_"))).toEqual(["cat_a"]);
        expect(await ids(startsWithText(categories.slug, "summer-cotton-tees-"))).toEqual(["cat_b", "cat_c"]);
        expect(await ids(handleOrNumberedCopy(categories.slug, "summer-cotton-tees"))).toEqual(["cat_a", "cat_b", "cat_c"]);
    });

    it("reads the admin order detail with its money chain and customer record", async () => {
        const { db, client } = await createNativePostgres({ label: "order_detail" });
        await client.query(`
            INSERT INTO customers (id, name, email, phone, origin) VALUES ('cust_1', 'Nadia', 'nadia@example.test', '+8801711000001', 'account');
            INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone,
                total_amount_minor, balance_due_minor, customer_id, order_number)
              VALUES ('ORDERDETAILPG001', 'Nadia', '+8801711000001', 'House 1', 'c', 'z', 50000, 50000, 'cust_1', 1001);
        `);

        const details = await getOrderDetails(db, "ORDERDETAILPG001");

        expect(details).toMatchObject({
            id: "ORDERDETAILPG001",
            moneyChain: null,
            customerRecord: { id: "cust_1", name: "Nadia", phone: "+8801711000001" },
        });
        expect(await getOrderDetails(db, "ORDERMISSING0001")).toBeNull();
    });
});
