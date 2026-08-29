import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";
import { errorResponseFromError } from "../utils/api-response";
import { abandonedCheckoutsRoutes } from "./abandoned-checkouts";

function createTestApp() {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ get: async () => null }),
      }),
    })),
    insert: vi.fn(() => ({
      values: async (value: Record<string, unknown>) => {
        inserted.push(value);
      },
    })),
  };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/abandoned-checkouts", abandonedCheckoutsRoutes);
  return { app, db, inserted };
}

describe("public abandoned checkout snapshot route", () => {
  it("stores only the bounded recovery projection", async () => {
    const { app, inserted } = createTestApp();
    const response = await app.request("/api/v1/abandoned-checkouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkoutId: "chk_session_1234567890abcdef",
        customerPhone: "+8801712345678",
        checkoutData: {
          customerName: "Buyer",
          csrfToken: "do-not-store",
          cart: {
            totalAmount: 1200,
            items: [{ id: "prod_1", variantId: "var_1", name: "Shoe", quantity: 1, price: 1200 }],
          },
        },
      }),
    }, {} as Env);

    expect(response.status).toBe(200);
    expect(inserted).toHaveLength(1);
    const saved = inserted[0];
    expect(saved?.customerPhone).toBe("+8801712345678");
    expect(JSON.parse(String(saved?.checkoutData))).toEqual({
      customerName: "Buyer",
      cart: {
        items: [{ id: "prod_1", variantId: "var_1", name: "Shoe", quantity: 1, price: 1200 }],
        totalAmount: 1200,
        discount: null,
      },
    });
  });

  it("rejects short guessable identifiers before touching D1", async () => {
    const { app, db, inserted } = createTestApp();
    const response = await app.request("/api/v1/abandoned-checkouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkoutId: "checkout_1", checkoutData: {} }),
    }, {} as Env);

    expect(response.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it.each([undefined, "", "+880", "01700", "not-a-phone"])(
    "accepts a pre-contact snapshot and persists %s as unavailable",
    async (customerPhone) => {
      const { app, inserted } = createTestApp();
      const response = await app.request("/api/v1/abandoned-checkouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutId: "chk_session_1234567890abcdef",
          customerPhone,
          checkoutData: {
            customerPhone,
            cart: {
              totalAmount: 500,
              items: [{ id: "prod_1", name: "Shoe", quantity: 1, price: 500 }],
            },
          },
        }),
      }, {} as Env);

      expect(response.status).toBe(200);
      expect(inserted[0]?.customerPhone).toBeNull();
      expect(JSON.parse(String(inserted[0]?.checkoutData))).not.toHaveProperty("customerPhone");
    },
  );

  it("canonicalizes a valid phone without rejecting the cart snapshot", async () => {
    const { app, inserted } = createTestApp();
    const response = await app.request("/api/v1/abandoned-checkouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkoutId: "chk_session_1234567890abcdef",
        customerPhone: "+880 1712-345678",
        checkoutData: {
          customerPhone: "+880 1712-345678",
          cart: { items: [] },
        },
      }),
    }, {} as Env);

    expect(response.status).toBe(200);
    expect(inserted[0]?.customerPhone).toBe("+8801712345678");
    expect(JSON.parse(String(inserted[0]?.checkoutData)).customerPhone).toBe("+8801712345678");
  });

  it("preserves separate records for separate checkout sessions sharing a phone", async () => {
    const { app, inserted } = createTestApp();

    for (const checkoutId of [
      "chk_session_1234567890abcdef",
      "chk_session_fedcba0987654321",
    ]) {
      const response = await app.request("/api/v1/abandoned-checkouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutId,
          customerPhone: "+8801712345678",
          checkoutData: { cart: { items: [] } },
        }),
      }, {} as Env);
      expect(response.status).toBe(200);
    }

    expect(inserted).toHaveLength(2);
    expect(inserted.map((row) => row.checkoutId)).toEqual([
      "chk_session_1234567890abcdef",
      "chk_session_fedcba0987654321",
    ]);
    expect(inserted.map((row) => row.customerPhone)).toEqual([
      "+8801712345678",
      "+8801712345678",
    ]);
  });
});
