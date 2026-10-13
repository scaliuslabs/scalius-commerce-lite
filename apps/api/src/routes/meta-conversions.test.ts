import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  sendCapiEvent: vi.fn(),
  limiter: { limit: vi.fn(async (_input: { key: string }) => ({ success: true })) },
  getClientIp: vi.fn(() => "203.0.113.10"),
}));

vi.mock("@scalius/core/integrations/meta/conversions-api", () => ({
  sendCapiEvent: mocks.sendCapiEvent,
}));

vi.mock("@scalius/shared/rate-limit", () => ({
  getClientIp: mocks.getClientIp,
}));

import { metaConversionsRoutes } from "./meta-conversions";
import { META_CAPI_BROWSER_CIRCUIT_KEY } from "../utils/meta-capi-circuit";

function createTestApp() {
  const { db, sqlite } = createSqliteD1Database();
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.env.RL_STANDARD ??= mocks.limiter;
    await next();
  });
  app.route("/meta", metaConversionsRoutes);
  const circuit = () => sqlite.prepare("SELECT value, expires_at FROM system_kv WHERE key = ?")
    .get(META_CAPI_BROWSER_CIRCUIT_KEY) as { value: string; expires_at: number } | undefined;
  const openCircuit = (openUntil: number) => sqlite.prepare("INSERT INTO system_kv (key, value, expires_at) VALUES (?, ?, ?)")
    .run(META_CAPI_BROWSER_CIRCUIT_KEY, JSON.stringify({ reason: "Invalid OAuth access token.", eventName: "Purchase", openUntil }), Math.ceil(openUntil / 1000));
  return { app, db, circuit, openCircuit };
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
    mocks.limiter.limit.mockResolvedValue({ success: true });
    mocks.sendCapiEvent.mockResolvedValue({ success: true });
  });

  it("honors a browser-provided event id for Pixel/CAPI deduplication", async () => {
    const { app, db } = createTestApp();
    const response = await app.request(
      "/api/v1/meta/events",
      createRequest({ eventId: "Purchase:order_1" }),
      {
        STOREFRONT_URL: "https://store.example",
        CREDENTIAL_ENCRYPTION_KEY: "encryption-key",
      } as never,
    );

    const body = await response.json() as { data?: { eventId?: string } };
    expect(response.status).toBe(200);
    expect(body.data?.eventId).toBe("Purchase:order_1");
    expect(mocks.limiter.limit).toHaveBeenCalledWith({ key: expect.stringMatching(/^[a-f0-9]{64}$/) });
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
      } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.sendCapiEvent).not.toHaveBeenCalled();
  });

  it("rate limits public browser event ingestion before sending to Meta", async () => {
    mocks.limiter.limit.mockResolvedValueOnce({ success: false });

    const { app } = createTestApp();
    const response = await app.request(
      "/api/v1/meta/events",
      createRequest({ eventId: "Purchase:order_1" }),
      {
        STOREFRONT_URL: "https://store.example",
      } as never,
    );

    expect(response.status).toBe(429);
    expect(mocks.sendCapiEvent).not.toHaveBeenCalled();
  });

  it("uses the standard native limiter and writes no circuit row on success", async () => {
    const limiter = { limit: vi.fn(async () => ({ success: true })) };

    const { app, circuit } = createTestApp();
    const response = await app.request(
      "/api/v1/meta/events",
      createRequest({ eventId: "Purchase:order_1" }),
      {
        RL_STANDARD: limiter,
        STOREFRONT_URL: "https://store.example",
      } as never,
    );

    expect(response.status).toBe(200);
    expect(limiter.limit).toHaveBeenCalledWith({ key: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(circuit()).toBeUndefined();
  });

  it("opens a 15-minute circuit row after non-retryable provider failures", async () => {
    mocks.sendCapiEvent.mockResolvedValueOnce({
      success: false,
      error: "Invalid OAuth access token.",
      retryable: false,
    });

    const { app, circuit } = createTestApp();
    const before = Math.floor(Date.now() / 1000);
    const response = await app.request(
      "/api/v1/meta/events",
      createRequest({ eventId: "Purchase:order_1" }),
      { STOREFRONT_URL: "https://store.example" } as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.sendCapiEvent).toHaveBeenCalledTimes(1);
    const row = circuit();
    expect(row?.value).toContain("Invalid OAuth access token.");
    expect(row?.expires_at).toBeGreaterThanOrEqual(before + 900);
    expect(row?.expires_at).toBeLessThanOrEqual(before + 902);
  });

  it("keeps dispatching after a retryable provider failure", async () => {
    mocks.sendCapiEvent.mockResolvedValueOnce({ success: false, error: "Timeout", retryable: true });

    const { app, circuit } = createTestApp();
    await app.request(
      "/api/v1/meta/events",
      createRequest({ eventId: "Purchase:order_1" }),
      { STOREFRONT_URL: "https://store.example" } as never,
    );

    expect(circuit()).toBeUndefined();
  });

  it("skips provider dispatch while the browser-event circuit is open", async () => {
    const { app, openCircuit } = createTestApp();
    openCircuit(Date.now() + 60_000);
    const response = await app.request(
      "/api/v1/meta/events",
      createRequest({ eventId: "Purchase:order_1" }),
      { STOREFRONT_URL: "https://store.example" } as never,
    );
    const body = await response.json() as { data?: { message?: string } };

    expect(response.status).toBe(200);
    expect(body.data?.message).toContain("recently failed");
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.sendCapiEvent).not.toHaveBeenCalled();
  });

  it("dispatches again once the circuit has expired", async () => {
    const { app, openCircuit } = createTestApp();
    openCircuit(Date.now() - 1_000);
    const response = await app.request(
      "/api/v1/meta/events",
      createRequest({ eventId: "Purchase:order_1" }),
      { STOREFRONT_URL: "https://store.example" } as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.sendCapiEvent).toHaveBeenCalledTimes(1);
  });
});
