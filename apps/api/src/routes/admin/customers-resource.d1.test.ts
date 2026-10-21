// Customer writes in the stable app API: `customers.create` takes the one
// postal address shape (place ids only under `placeIds`), and create,
// update and set_tags answer the customer as `customers.get` reads it.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { errorResponseFromError } from "../../utils/api-response";
import { adminCustomerRoutes } from "./customers";
import { adminCustomerMarketingRoutes } from "./customer-marketing";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  // Bangladesh's City > Thana > Area the address names by id.
  sqlite.exec(`INSERT INTO places (id, country_code, level, parent_id, name, external_ids, metadata) VALUES
    ('city_dhaka', 'BD', 1, NULL, 'Dhaka', '{}', '{}'),
    ('zone_gulshan', 'BD', 2, 'city_dhaka', 'Gulshan', '{}', '{}'),
    ('area_gulshan_1', 'BD', 3, 'zone_gulshan', 'Gulshan 1', '{}', '{}');`);
});
afterEach(() => sqlite.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.
type Wire = { status: number; body: { data: any; error: { code: string; message: string } } };

async function call(method: string, path: string, body?: unknown): Promise<Wire> {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/customers", adminCustomerMarketingRoutes);
  app.route("/customers", adminCustomerRoutes);
  app.onError((error, c) => { const { body: errorBody, status } = errorResponseFromError(error); return c.json(errorBody, status); });
  const response = await app.request(`/api/v1/admin${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, {} as never);
  return { status: response.status, body: await response.json() as Wire["body"] };
}

const address = {
  countryCode: "BD",
  name: "Rahim",
  line1: "House 12, Road 5",
  placeIds: { city: "city_dhaka", zone: "zone_gulshan", area: "area_gulshan_1" },
};

describe("customers.create", () => {
  it("takes the postal address and answers the customer", async () => {
    const created = await call("POST", "/customers", {
      name: "Rahim Uddin", email: "rahim@example.com", phone: "+8801712345678", address,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { customer } = created.body.data;
    expect(customer).toMatchObject({ name: "Rahim Uddin", email: "rahim@example.com", tags: [] });
    const stored = sqlite.prepare("SELECT city, zone, area, line1 FROM customer_addresses WHERE customer_id = ?").get(customer.id);
    expect(stored).toMatchObject({ city: "city_dhaka", zone: "zone_gulshan", area: "area_gulshan_1", line1: "House 12, Road 5" });
  });

  it("refuses the flat place ids and the old validation flag", async () => {
    const flat = await call("POST", "/customers", {
      name: "Karim Mia", email: null, phone: "+8801712345679",
      address: { countryCode: "BD", line1: "House 1", city: "city_dhaka", zone: "zone_gulshan", area: "area_gulshan_1" },
    });
    expect(flat.status).toBe(400);
    const flag = await call("POST", "/customers", {
      name: "Karim Mia", email: null, phone: "+8801712345679", address: { ...address, skipValidation: true },
    });
    expect(flag.status).toBe(400);
    expect(sqlite.prepare("SELECT count(*) AS n FROM customers").get()).toEqual({ n: 0 });
  });
});

describe("customers.update and customers.set_tags", () => {
  it("answer the customer as customers.get reads it", async () => {
    const { customer } = (await call("POST", "/customers", { name: "Rahim Uddin", email: null, phone: "+8801712345678" })).body.data;
    const updated = await call("PUT", `/customers/${customer.id}`, { name: "Rahim U." });
    expect(updated.status).toBe(200);
    expect(updated.body.data.customer).toMatchObject({ id: customer.id, name: "Rahim U." });
    const tagged = await call("PUT", `/customers/${customer.id}/tags`, { tags: ["VIP", "wholesale"] });
    expect(tagged.status).toBe(200);
    expect(tagged.body.data.customer).toMatchObject({ id: customer.id, tags: ["vip", "wholesale"] });
    expect((await call("PUT", "/customers/cus_missing/tags", { tags: ["vip"] })).status).toBe(404);
  });
});
