import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { generateToken } from "../utils/jwt";
import publicBuyerApp from "./public-buyer-app";
import publicCatalogApp from "./public-catalog-app";

const JWT_SECRET = "public-route-boundary-secret-0123456789";

function request(app: typeof publicBuyerApp, path: string, init: RequestInit = {}) {
  const { binding } = createSqliteD1Database();
  return app.request(`https://api.example.test/api/v1${path}`, init, {
    DB: binding,
    JWT_SECRET,
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
  } as unknown as Env);
}

const themePreview = (headers: Record<string, string> = {}) => request(
  publicBuyerApp,
  "/storefront/agent-continuations/theme-preview",
  {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ continuationCode: `tpc_${"a".repeat(48)}` }),
  },
);

describe("public buyer runtime auth boundaries", () => {
  it("keeps proof-based order routes reachable without a bearer token", async () => {
    expect((await request(publicBuyerApp, "/orders/status/cst_notarealtoken")).status).toBe(400);
    expect((await request(publicBuyerApp, "/orders/receipt/order_1")).status).toBe(404);
  });

  it("puts the agent principal in front of storefront agent contexts", async () => {
    const response = await request(publicBuyerApp, "/storefront/agent-contexts", { method: "POST" });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("requires service JWT auth for hosted continuations and keeps authenticated responses private", async () => {
    const anonymous = await themePreview();
    const service = await themePreview({
      Authorization: `Bearer ${generateToken({ id: "storefront", role: "service" }, "5m", { JWT_SECRET })}`,
    });

    expect(anonymous.status).toBe(401);
    expect(service.status).not.toBe(401);
    expect(service.headers.get("Cache-Control")).toBe("private, no-cache, no-store, must-revalidate");
  });
});

describe("public catalog runtime boundaries", () => {
  it.each([
    ["/products?limit=101", "/products?limit=100"],
    ["/products?page=1001", "/products?page=1000"],
    ["/products/search?search=shirt&page=1001", "/products/search?search=shirt&page=1000"],
    ["/products/feed?limit=101", "/products/feed?limit=100"],
    ["/categories/shirts/products?limit=101", "/categories/shirts/products?limit=100"],
  ])("rejects unbounded listing input %s before reading the catalog", async (unbounded, bounded) => {
    expect((await request(publicCatalogApp, unbounded)).status).toBe(400);
    expect((await request(publicCatalogApp, bounded)).status).not.toBe(400);
  });

  it("returns an authoritative 404 for absent collections and categories", async () => {
    expect((await request(publicCatalogApp, "/collections/missing")).status).toBe(404);
    expect((await request(publicCatalogApp, "/categories/missing/products")).status).toBe(404);
  });
});
