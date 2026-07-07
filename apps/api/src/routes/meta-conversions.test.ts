import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  sendCapiEvent: vi.fn(),
  rateLimit: vi.fn(),
  getClientIp: vi.fn(() => "203.0.113.10"),
}));

vi.mock("@scalius/core/integrations/meta/conversions-api", () => ({
  sendCapiEvent: mocks.sendCapiEvent,
}));

vi.mock("@scalius/shared/rate-limit", () => ({
  getClientIp: mocks.getClientIp,
  rateLimit: mocks.rateLimit,
}));

import {
  META_CAPI_BROWSER_CIRCUIT_KEY,
  metaConversionsRoutes,
} from "./meta-conversions";

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
  app.route("/meta", metaConversionsRoutes);
  return { app, db };
}

function createRequest(body: Record<string, unknown>) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "user-agent": "Vitest Browser",
      "cf-connecting-ip": "203.0.113.10",
    },
    body: JSON.stringify({
      eventName: "Purchase",
      eventSourceUrl: "https://store.example/order-success?orderId=order_1",
      userData: {},
      customData: {
        order_id: "order_1",
        currency: "BDT",
        value: 1000,
      },
      ...body,
    }),
  };
}

describe("Meta conversions public event route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimit.mockResolvedValue({
      allowed: true,
      remaining: 119,
      resetAt: Date.now() + 60_000,
    });
    mocks.sendCapiEvent.mockResolvedValue({ success: true });
  });

  it("honors a browser-provided event id for Pixel/CAPI deduplication", async () => {
    const { app, db } = createTestApp();
    const cache = { get: vi.fn(), put: vi.fn() };
    const response = await app.request(
      "/api/v1/meta/events",
      createRequest({ eventId: "Purchase:order_1" }),
      {
        CACHE: cache,
        STOREFRONT_URL: "https://store.example",
        CREDENTIAL_ENCRYPTION_KEY: "encryption-key",
      } as never,
    );

    const body = await response.json() as { data?: { eventId?: string } };
    expect(response.status).toBe(200);
    expect(body.data?.eventId).toBe("Purchase:order_1");
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        kv: cache,
        key: "meta-events:203.0.113.10",
        limit: 120,
        windowMs: 60_000,
      }),
    );
    expect(mocks.sendCapiEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        event_id: "Purchase:order_1",
        event_source_url: "https://store.example/order-success?orderId=order_1",
        user_data: expect.objectContaining({
          client_ip_address: "203.0.113.10",
          client_user_agent: "Vitest Browser",
        }),
      }),
      { encryptionKey: "encryption-key" },
    );
  });

  it("rejects event source origins that do not match the storefront origin", async () => {
    const { app } = createTestApp();
    const response = await app.request(
      "/api/v1/meta/events",
      createRequest({
        eventId: "Purchase:order_1",
        eventSourceUrl: "https://attacker.example/order-success",
      }),
      {
        CACHE: { get: vi.fn(), put: vi.fn() },
        STOREFRONT_URL: "https://store.example",
      } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.sendCapiEvent).not.toHaveBeenCalled();
  });

  it("does not use JWT fallback as the Meta CAPI credential decrypt key", async () => {
    const { app } = createTestApp();
    const response = await app.request(
      "/api/v1/meta/events",
      createRequest({ eventId: "Purchase:order_1" }),
      {
        CACHE: { get: vi.fn(), put: vi.fn() },
        STOREFRONT_URL: "https://store.example",
        JWT_SECRET: "legacy-jwt-key",
      } as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.sendCapiEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { encryptionKey: undefined },
    );
  });

  it("fails closed when the trusted storefront origin is not configured", async () => {
    const { app } = createTestApp();
    const response = await app.request(
      "/api/v1/meta/events",
      createRequest({
        eventId: "Purchase:order_1",
        eventSourceUrl: "https://store.example/order-success",
      }),
      {
        CACHE: { get: vi.fn(), put: vi.fn() },
      } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.sendCapiEvent).not.toHaveBeenCalled();
  });

  it("rate limits public browser event ingestion before sending to Meta", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const { app } = createTestApp();
    const response = await app.request(
      "/api/v1/meta/events",
      createRequest({ eventId: "Purchase:order_1" }),
      {
        CACHE: { get: vi.fn(), put: vi.fn() },
        STOREFRONT_URL: "https://store.example",
      } as never,
    );

    expect(response.status).toBe(429);
    expect(mocks.sendCapiEvent).not.toHaveBeenCalled();
  });

  it("opens a short circuit after non-retryable provider failures", async () => {
    mocks.sendCapiEvent.mockResolvedValueOnce({
      success: false,
      error: "Invalid OAuth access token.",
      retryable: false,
    });
    const cache = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    };

    const { app } = createTestApp();
    const response = await app.request(
      "/api/v1/meta/events",
      createRequest({ eventId: "Purchase:order_1" }),
      {
        CACHE: cache,
        STOREFRONT_URL: "https://store.example",
      } as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.sendCapiEvent).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledWith(
      META_CAPI_BROWSER_CIRCUIT_KEY,
      expect.stringContaining("Invalid OAuth access token."),
      { expirationTtl: 900 },
    );
  });

  it("skips provider dispatch while the browser-event circuit is open", async () => {
    const cache = {
      get: vi.fn(async () =>
        JSON.stringify({
          reason: "Invalid OAuth access token.",
          eventName: "Purchase",
          openedAt: Date.now(),
        }),
      ),
      put: vi.fn(async () => undefined),
    };

    const { app } = createTestApp();
    const response = await app.request(
      "/api/v1/meta/events",
      createRequest({ eventId: "Purchase:order_1" }),
      {
        CACHE: cache,
        STOREFRONT_URL: "https://store.example",
      } as never,
    );
    const body = await response.json() as { data?: { message?: string } };

    expect(response.status).toBe(200);
    expect(body.data?.message).toContain("recently failed");
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.sendCapiEvent).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });
});
