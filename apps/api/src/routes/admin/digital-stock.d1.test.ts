// The dashboard sees the digital stock rule as a 400 with the rule's message
// and `details.reason` (migrated schema): manual inventory adjustments, the
// scanner's adjust and count, and a variant quantity edit on a digital SKU,
// whose stock is its licence keys.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { DIGITAL_STOCK_IS_KEYS_MESSAGE, DIGITAL_STOCK_IS_KEYS_REASON } from "@scalius/core/modules/products";

import { errorResponseFromError } from "../../utils/api-response";
import { adminInventoryRoutes } from "./inventory";
import { adminProductsRoutes } from "./products";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`
    INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_app', 'Photo editor', 'photo-editor', 90000, 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES ('var_app', 'prod_app', 'APP-1', 90000, 3, 0, 1, 1, 1, 'digital');
  `);
});
afterEach(() => sqlite.close());

function app() {
  const router = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  router.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user" as never, { id: "usr_staff" } as never);
    // Staff who edit products adjust stock too (migration 0158 kept that).
    c.set("adminPermissions" as never, new Set(["products.view", "products.edit", "products.adjust_stock"]) as never);
    await next();
  });
  router.route("/inventory", adminInventoryRoutes);
  router.route("/products", adminProductsRoutes);
  router.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  return router;
}

async function call(method: string, path: string, body: unknown) {
  const response = await app().request(`/api/v1/admin${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads the JSON body freely
  return { status: response.status, body: (await response.json()) as any };
}

const refused = {
  success: false,
  error: {
    code: "VALIDATION_ERROR",
    message: DIGITAL_STOCK_IS_KEYS_MESSAGE,
    details: { reason: DIGITAL_STOCK_IS_KEYS_REASON },
  },
};

describe("digital stock rule over HTTP", () => {
  it("answers 400 with the message and reason on every manual inventory path", async () => {
    const adjust = await call("POST", "/inventory/var_app/adjust", { operationKey: "digital-http-adjust-0001", delta: 2, reason: "correction" });
    expect(adjust).toMatchObject({ status: 400, body: refused });
    const scan = await call("POST", "/inventory/stock-adjust", { operationKey: "digital-http-scan-00001", variantId: "var_app", adjustment: -1 });
    expect(scan).toMatchObject({ status: 400, body: refused });
    const count = await call("POST", "/inventory/stock-set", { operationKey: "digital-http-count-0001", variantId: "var_app", newStock: 9 });
    expect(count).toMatchObject({ status: 400, body: refused });
    expect(sqlite.prepare("SELECT stock FROM product_variants WHERE id = 'var_app'").get()).toEqual({ stock: 3 });
  });

  it("answers 400 with the field for a variant quantity edit", async () => {
    const response = await call("PUT", "/products/prod_app/variants/var_app", {
      selectedOptionValueIds: [], imageId: null, weight: null, sku: "APP-1", price: 900,
      stock: 10, expectedStockVersion: 1, trackInventory: true, expectedAggregateRevision: 1,
    });
    expect(response).toMatchObject({
      status: 400,
      body: { ...refused, error: { ...refused.error, details: { reason: DIGITAL_STOCK_IS_KEYS_REASON, field: "stock" } } },
    });
  });
});
