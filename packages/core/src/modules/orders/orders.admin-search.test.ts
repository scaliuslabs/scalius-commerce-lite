import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { listOrders } from "./orders.admin";

function setup() {
  const harness = createSqliteD1Database();
  harness.sqlite.exec(`
    INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone,
      total_amount, shipping_charge, payment_method, status, payment_status, paid_amount, balance_due,
      currency_code, currency_decimal_places)
    VALUES
      ('ORDERAAA111', 'Rahim Uddin', '+8801711111111', 'Mirpur', 'city', 'zone', 100, 0, 'cod', 'shipped', 'unpaid', 0, 100, 'BDT', 2),
      ('ORDERBBB222', 'Karim Ali', '+8801822222222', 'Uttara', 'city', 'zone', 100, 0, 'cod', 'pending', 'unpaid', 0, 100, 'BDT', 2);
    INSERT INTO delivery_providers (id, name, type, credentials, config)
      VALUES ('provider', 'Steadfast', 'steadfast', '{}', '{}');
    INSERT INTO delivery_shipments (id, order_id, provider_id, provider_type, status, external_id, tracking_id)
      VALUES ('shipment', 'ORDERAAA111', 'provider', 'steadfast', 'in_transit', '98765432', 'SFR-TRK-7');
  `);
  return harness;
}

const ids = async (db: ReturnType<typeof setup>["db"], search: string) =>
  (await listOrders(db, { search })).orders.map((order) => order.id);

describe("admin order search", () => {
  it("finds an order by the courier consignment or tracking id", async () => {
    const { db, sqlite } = setup();
    expect(await ids(db, "98765432")).toEqual(["ORDERAAA111"]);
    expect(await ids(db, "sfr-trk-7")).toEqual(["ORDERAAA111"]);
    sqlite.close();
  });

  it("keeps phone and name search working and never returns everything for an unmatched term", async () => {
    const { db, sqlite } = setup();
    expect(await ids(db, "01822222222")).toEqual(["ORDERBBB222"]);
    expect(await ids(db, "+880 1711-111111")).toEqual(["ORDERAAA111"]);
    expect(await ids(db, "Karim")).toEqual(["ORDERBBB222"]);
    expect(await ids(db, "no-such-thing-42")).toEqual([]);
    sqlite.close();
  });
});
