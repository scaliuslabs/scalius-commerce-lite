import { putObjectRecord } from "@scalius/core/modules/objects";
// App list columns and filters on the dashboard's customers, orders and
// products lists, on the migrated schema: values come from the app's records
// (keyed by the row's id) and its own custom fields in one statement for the
// page; a filter is an index match on a field its collection indexes first;
// unknown, foreign or inactive columns and filters on an unindexed field
// answer 400; a list request without app columns reads nothing more.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, deactivatePlugin, installPlugin, requirePluginInstallation } from "@scalius/core/modules/plugins";
import { PLUGIN_API_VERSION, parsePluginManifest, type PluginManifestInput } from "@scalius/shared/plugins";
import { errorResponseFromError } from "../../utils/api-response";
import { pluginBridgeAuthority } from "../../plugins/host";
import { setPluginCustomFieldValues } from "../../plugins/custom-fields";
import { adminCustomerRoutes } from "./customers";
import { adminOrderListRoutes } from "./orders/list";
import { adminProductsRoutes } from "./products";

const MANIFEST: PluginManifestInput = {
  id: "acme.members",
  name: "Members",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Member tiers and points.",
  author: { name: "Acme" },
  objects: { members: {
    name: "Members",
    fields: [
      { key: "tier", name: "Tier", type: "single_line_text" },
      { key: "points", name: "Points", type: "integer" },
      { key: "vip", name: "VIP", type: "boolean" },
      { key: "wallet", name: "Wallet", type: "money" },
    ],
    indexes: ["tier", ["points", "tier"], "wallet"],
  } },
  customFields: [{ ownerType: "order", key: "pack_note", name: "Pack note", type: "single_line_text" }],
  admin: {
    listColumns: [
      { id: "points", resource: "customer", title: "Points", type: "number", source: { kind: "object", object: "members", field: "points" } },
      { id: "tier", resource: "customer", title: "Tier", type: "text", filterable: true, source: { kind: "object", object: "members", field: "tier" } },
      { id: "vip", resource: "customer", title: "VIP", type: "boolean", source: { kind: "object", object: "members", field: "vip" } },
      { id: "wallet", resource: "customer", title: "Wallet", type: "money", filterable: true, source: { kind: "object", object: "members", field: "wallet" } },
      { id: "pack", resource: "order", title: "Pack note", type: "text", source: { kind: "customField", key: "pack_note" } },
    ],
  },
};

let sqlite: DatabaseSync;
let db: Database;
let queries: string[];

beforeEach(async () => {
  queries = [];
  ({ sqlite, db } = createSqliteD1Database({ onQuery: (query) => queries.push(query) }));
  sqlite.exec(`
    UPDATE markets SET price_increment_minor = 1 WHERE id = 'mkt_backup';
    INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
    INSERT INTO customers (id, name, phone) VALUES ('cus_a', 'Asha', '+8801711000001'), ('cus_b', 'Bilal', '+8801711000002'), ('cus_c', 'Chandra', '+8801711000003');
    INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status) VALUES
      ('ord_1', 'Asha', '+8801711000001', 'House 1', 'city_1', 'zone_1', 'pending'),
      ('ord_2', 'Bilal', '+8801711000002', 'House 2', 'city_1', 'zone_1', 'pending');
    INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('prod_a', 'Panjabi', 100000, 'panjabi', 1);
  `);
  await installPlugin(db, { manifest: MANIFEST, source: "upload", bundleSha256: "6".repeat(64), actorUserId: "owner" });
  await activatePlugin(db, "acme.members", { actorUserId: "owner", expectedRevision: 1 });
  const installation = await requirePluginInstallation(db, "acme.members");
  const declaration = installation.manifest.objects.members!;
  await putObjectRecord(db, "acme.members", "members", declaration, "cus_a", { tier: "gold", points: 1200, vip: true, wallet: { amountMinor: 25050, currency: "BDT" } });
  await putObjectRecord(db, "acme.members", "members", declaration, "cus_b", { tier: "silver", points: 40, vip: false, wallet: { amountMinor: 0, currency: "BDT" } });
  await setPluginCustomFieldValues(db, "acme.members", pluginBridgeAuthority(installation).customFields, "order", "ord_1", { pack_note: "Gift wrap" });
});
afterEach(() => sqlite.close());

function app() {
  const router = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  router.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  router.route("/customers", adminCustomerRoutes);
  router.route("/orders", adminOrderListRoutes);
  router.route("/products", adminProductsRoutes);
  router.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  return router;
}

async function get(path: string) {
  const response = await app().request(`/api/v1/admin${path}`, {}, { TZ: "Asia/Dhaka" } as unknown as Env);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads the JSON body freely
  return { status: response.status, body: await response.json() as { data: any; error: { code: string; message: string } } };
}

describe("app list columns and filters", () => {
  it("adds the page's values of object and custom-field columns in one statement", async () => {
    queries = [];
    const plain = await get("/customers?limit=10");
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(plain.body.data.appValues).toBeUndefined();
    const plainReads = queries.length;

    queries = [];
    const withColumns = await get("/customers?limit=10&appColumns=acme.members/points,acme.members/tier,acme.members/vip");
    expect(withColumns.status).toBe(200);
    // The installations once, the values once: two statements more, whatever the page size.
    expect(queries.length).toBe(plainReads + 2);
    expect(withColumns.body.data.appValues).toEqual({
      cus_a: { "acme.members/points": 1200, "acme.members/tier": "gold", "acme.members/vip": true },
      cus_b: { "acme.members/points": 40, "acme.members/tier": "silver", "acme.members/vip": false },
      cus_c: { "acme.members/points": null, "acme.members/tier": null, "acme.members/vip": null },
    });

    const ordersPage = await get("/orders?limit=10&appColumns=acme.members/pack");
    expect(ordersPage.status).toBe(200);
    expect(ordersPage.body.data.appValues).toEqual({
      ord_1: { "acme.members/pack": "Gift wrap" },
      ord_2: { "acme.members/pack": null },
    });
  });

  it("filters by an indexed app field, as an index match folded into the list", async () => {
    const gold = await get("/customers?limit=10&appFilter=acme.members/tier:gold");
    expect(gold.status).toBe(200);
    expect(gold.body.data.customers.map((customer: { id: string }) => customer.id)).toEqual(["cus_a"]);
    expect(gold.body.data.pagination.total).toBe(1);
    const index = queries.find((query) => query.includes("object_records") && query.includes("k1"));
    expect(index).toBeDefined();
  });

  it("shows and filters money in major units: the object stores minor units", async () => {
    const page = await get("/customers?limit=10&appColumns=acme.members/wallet&appFilter=acme.members/wallet:250.50");
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.data.customers.map((customer: { id: string }) => customer.id)).toEqual(["cus_a"]);
    expect(page.body.data.appValues).toEqual({ cus_a: { "acme.members/wallet": 250.5 } });
    expect((await get("/customers?appFilter=acme.members/wallet:lots")).status).toBe(400);
  });

  it("refuses unknown, foreign and inactive columns and a filter on an unindexed field", async () => {
    expect((await get("/customers?appColumns=acme.members/unknown")).status).toBe(400);
    expect((await get("/customers?appColumns=acme.members/pack")).status).toBe(400);
    expect((await get("/products?appColumns=acme.members/points")).status).toBe(400);
    expect((await get("/customers?appFilter=acme.members/vip:true")).status).toBe(400);
    expect((await get("/customers?appFilter=missing-colon")).status).toBe(400);
    expect((await get(`/customers?appColumns=${Array.from({ length: 6 }, (_, index) => `acme.members/c${index}`).join(",")}`)).status).toBe(400);
    await deactivatePlugin(db, "acme.members", { expectedRevision: (await requirePluginInstallation(db, "acme.members")).revision });
    expect((await get("/customers?appColumns=acme.members/points")).status).toBe(400);
  });

  it("refuses a manifest whose column filters by an unindexed field or names an undeclared source", () => {
    const issues = (input: PluginManifestInput) => {
      const parsed = parsePluginManifest(input);
      return parsed.ok ? [] : parsed.issues.map((issue) => issue.message);
    };
    const column = MANIFEST.admin!.listColumns![0]!;
    // points leads the compound index (points, tier); vip leads none.
    expect(issues({ ...MANIFEST, admin: { listColumns: [{ ...column, filterable: true }] } })).toEqual([]);
    expect(issues({ ...MANIFEST, admin: { listColumns: [{ ...MANIFEST.admin!.listColumns![2]!, filterable: true }] } }))
      .toEqual(["Index vip first in collection members to filter by it."]);
    expect(issues({ ...MANIFEST, admin: { listColumns: [{ ...column, source: { kind: "object", object: "ledger", field: "points" } }] } }))
      .toEqual(["Object type ledger is not declared."]);
    expect(issues({ ...MANIFEST, admin: { listColumns: [{ ...column, resource: "product", source: { kind: "customField", key: "pack_note" } }] } }))
      .toEqual(["Custom field product.pack_note is not declared."]);
  });
});
