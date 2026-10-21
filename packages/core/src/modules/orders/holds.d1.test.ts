// An app releases only the hold its own `ctx.orders.hold` placed (audit I9):
// under the order's revision, which the release advances; never another
// app's hold or the platform's review of a payment the app recorded; a
// repeat changes nothing.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ConflictError, NotFoundError } from "../../errors";
import { appOrderHoldId, assertOrderNotOnHold, placeAppOrderHolds, releaseAppOrderHold, releaseOrderHold } from "./holds";

let sqlite: DatabaseSync;
let db: Database;

const version = () => (sqlite.prepare("SELECT version FROM orders WHERE id = 'o_b2b'").get() as { version: number }).version;
const openHolds = () => (sqlite.prepare("SELECT plugin_id FROM order_holds WHERE order_id = 'o_b2b' AND released_at IS NULL ORDER BY plugin_id, id").all() as Array<{ plugin_id: string }>)
  .map((row) => row.plugin_id);

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, version)
    VALUES ('o_b2b', 'Buyer', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'confirmed', 3)`);
});
afterEach(() => sqlite.close());

describe("an app releasing its own hold", () => {
  it("releases its hold under the revision it read, advancing it once", async () => {
    await placeAppOrderHolds(db, "o_b2b", [
      { pluginId: "acme.b2b", appName: "Acme B2B", reasons: ["Waiting for the approver."] },
      { pluginId: "acme.risk", appName: "Acme Risk", reasons: ["Velocity"] },
    ]);
    await expect(releaseAppOrderHold(db, { orderId: "o_b2b", pluginId: "acme.b2b", expectedVersion: 2 })).rejects.toBeInstanceOf(ConflictError);
    expect(openHolds()).toEqual(["acme.b2b", "acme.risk"]);
    expect(version()).toBe(3);

    const released = await releaseAppOrderHold(db, { orderId: "o_b2b", pluginId: "acme.b2b", expectedVersion: 3 });
    expect(released).toMatchObject({ replayed: false, hold: { pluginId: "acme.b2b", releasedBy: null } });
    expect(released.hold.releasedAt).not.toBeNull();
    expect(version()).toBe(4);
    expect(openHolds()).toEqual(["acme.risk"]);
    // A repeat, on any revision, changes nothing.
    expect(await releaseAppOrderHold(db, { orderId: "o_b2b", pluginId: "acme.b2b", expectedVersion: 3 })).toMatchObject({ replayed: true });
    expect(version()).toBe(4);
    // The other app's hold still stops the order.
    await expect(assertOrderNotOnHold(db, "o_b2b")).rejects.toThrow(/Acme Risk/);
  });

  it("never reaches another app's hold, the platform's review or a missing order", async () => {
    await placeAppOrderHolds(db, "o_b2b", [{ pluginId: "acme.risk", appName: "Acme Risk", reasons: ["Velocity"] }]);
    // The platform's payment review carries the app's id but another hold id.
    sqlite.exec(`INSERT INTO order_holds (id, order_id, plugin_id, app_name, reason)
      VALUES ('ohd_${"c".repeat(32)}', 'o_b2b', 'acme.b2b', 'Acme B2B', 'Payment review')`);
    await expect(releaseAppOrderHold(db, { orderId: "o_b2b", pluginId: "acme.b2b", expectedVersion: 3 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(releaseAppOrderHold(db, { orderId: "o_none", pluginId: "acme.risk", expectedVersion: 1 })).rejects.toBeInstanceOf(NotFoundError);
    expect(openHolds()).toEqual(["acme.b2b", "acme.risk"]);
    expect(version()).toBe(3);
  });

  it("answers a hold staff released first as released, without a revision check", async () => {
    await placeAppOrderHolds(db, "o_b2b", [{ pluginId: "acme.b2b", appName: "Acme B2B", reasons: ["Approval"] }]);
    await releaseOrderHold(db, "o_b2b", await appOrderHoldId("o_b2b", "acme.b2b"), null);
    expect(await releaseAppOrderHold(db, { orderId: "o_b2b", pluginId: "acme.b2b", expectedVersion: 99 })).toMatchObject({ replayed: true });
    expect(version()).toBe(3);
  });
});
