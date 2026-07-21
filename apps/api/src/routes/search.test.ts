import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  nativeRateLimit: vi.fn(),
  getClientIp: vi.fn(() => "203.0.113.24"),
}));

vi.mock("@scalius/core/search", () => ({
  sanitizeFtsQuery: (value: string) => {
    const cleaned = value.replace(/["\-*(){}[\]^~:\\/<>|@#&+!?.,'=\u0964\u0965]/g, " ").trim();
    return cleaned ? cleaned.split(/\s+/).map((token) => `${token}*`).join(" ") : "";
  },
  search: mocks.search,
}));

vi.mock("@scalius/shared/rate-limit", () => ({
  getClientIp: mocks.getClientIp,
}));

import { searchRoutes } from "./search";

function createTestApp() {
  const db = { id: "db" };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/search", searchRoutes);
  return { app, db };
}

function createSearchEnv() {
  return {
    SEARCH_RATE_LIMITER: {
      limit: mocks.nativeRateLimit,
    },
  } as unknown as Env;
}

describe("public search route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getClientIp.mockReturnValue("203.0.113.24");
    mocks.nativeRateLimit.mockResolvedValue({ success: true });
    mocks.search.mockResolvedValue({
      products: [{ id: "prod_1", name: "Fresh Hilsa", slug: "fresh-hilsa", price: 1200 }],
      pages: [],
      categories: [],
    });
  });

  it("normalizes search query whitespace before native rate limiting and FTS work", async () => {
    const { app, db } = createTestApp();
    const response = await app.request(
      "/api/v1/search?q=%20%20Fresh%20%20%20Hilsa%20&limit=4",
      {},
      createSearchEnv(),
    );
    const body = await response.json() as { data?: { query?: string } };

    expect(response.status).toBe(200);
    expect(body.data?.query).toBe("Fresh Hilsa");
    expect(mocks.nativeRateLimit).toHaveBeenCalledWith({
      key: "search:203.0.113.24",
    });
    expect(mocks.search).toHaveBeenCalledWith(
      db,
      "Fresh Hilsa",
      expect.objectContaining({ limit: 4 }),
    );
  });

  it("treats punctuation-only search as empty before rate limiting or database work", async () => {
    const { app } = createTestApp();
    const response = await app.request("/api/v1/search?q=!!!!", {}, createSearchEnv());
    const body = await response.json() as { data?: { query?: string; products?: unknown[] } };

    expect(response.status).toBe(200);
    expect(body.data?.query).toBe("");
    expect(body.data?.products).toEqual([]);
    expect(mocks.nativeRateLimit).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("rejects excessive limits before search execution", async () => {
    const { app } = createTestApp();
    const response = await app.request(
      "/api/v1/search?q=fish&limit=5000",
      {},
      createSearchEnv(),
    );

    expect(response.status).toBe(400);
    expect(mocks.nativeRateLimit).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("rejects an empty numeric query parameter before rate limiting", async () => {
    const { app } = createTestApp();
    const response = await app.request("/api/v1/search?q=fish&limit=", {}, createSearchEnv());

    expect(response.status).toBe(400);
    expect(mocks.nativeRateLimit).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("uses the on-machine Cloudflare limiter before database search", async () => {
    mocks.nativeRateLimit.mockResolvedValueOnce({ success: false });

    const { app } = createTestApp();
    const response = await app.request("/api/v1/search?q=fish", {}, createSearchEnv());

    expect(response.status).toBe(429);
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
