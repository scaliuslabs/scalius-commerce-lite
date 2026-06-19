import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  sendOtp: vi.fn(),
  getCustomerBySession: vi.fn(),
  getCustomerOrders: vi.fn(),
  getSessionCookie: vi.fn(),
}));

vi.mock("@scalius/core/modules/customers/customer-auth.service", () => ({
  sendOtp: mocks.sendOtp,
  verifyOtp: vi.fn(),
  getCustomerBySession: mocks.getCustomerBySession,
  deleteCustomerSession: vi.fn(),
  updateCustomerProfile: vi.fn(),
  getSessionCookie: mocks.getSessionCookie,
  getCookieConfig: vi.fn(() => ({ sameSite: "Lax", domainAttr: "" })),
  buildSetCookieHeader: vi.fn(() => "cs_tok=session_1; Path=/; HttpOnly"),
  COOKIE_NAME: "cs_tok",
  SESSION_TTL_SECONDS: 2_592_000,
}));

vi.mock("@scalius/core/modules/customers/customers.service", () => ({
  getCustomerOrders: mocks.getCustomerOrders,
}));

import { customerAuthRoutes } from "./customer-auth";

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/customer-auth", customerAuthRoutes);
  return app;
}

describe("customer auth private cache policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionCookie.mockReturnValue("session_1");
    mocks.sendOtp.mockResolvedValue({
      success: true,
      message: "Verification code sent to your email",
    });
    mocks.getCustomerBySession.mockResolvedValue({
      email: "customer@example.com",
      name: "Customer",
      phone: "+8801712345678",
      customerId: "customer_1",
    });
    mocks.getCustomerOrders.mockResolvedValue({
      orders: [
        {
          id: "order_1",
          status: "pending",
          totalAmount: 100,
          createdAt: "2026-06-18T00:00:00.000Z",
          latestShipment: {
            id: "shipment_1",
            providerType: "steadfast",
            providerName: "Steadfast",
            status: "in_transit",
            rawStatus: "In Transit",
            trackingId: "SF123",
            trackingUrl: "https://steadfast.com.bd/t/SF123",
            courierName: null,
            lastChecked: "2026-06-18T01:00:00.000Z",
            updatedAt: "2026-06-18T01:00:00.000Z",
            createdAt: "2026-06-18T00:30:00.000Z",
          },
        },
      ],
      customerProfile: {
        id: "customer_1",
        name: "Customer",
        email: "customer@example.com",
        phone: "+8801712345678",
      },
    });
  });

  it("marks customer session reads as private no-store", async () => {
    const app = createTestApp();

    const response = await app.request(
      "/api/v1/customer-auth/me",
      { headers: { Cookie: "cs_tok=session_1" } },
      { CACHE: {} } as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate",
    );
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Expires")).toBe("0");
  });

  it("marks customer order-history reads as private no-store", async () => {
    const app = createTestApp();

    const response = await app.request(
      "/api/v1/customer-auth/orders",
      { headers: { Cookie: "cs_tok=session_1" } },
      { CACHE: {} } as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate",
    );
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Expires")).toBe("0");
  });

  it("returns customer shipment tracking summary with order history", async () => {
    const app = createTestApp();

    const response = await app.request(
      "/api/v1/customer-auth/orders",
      { headers: { Cookie: "cs_tok=session_1" } },
      { CACHE: {} } as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        orders: [
          {
            id: "order_1",
            latestShipment: {
              id: "shipment_1",
              providerType: "steadfast",
              providerName: "Steadfast",
              status: "in_transit",
              trackingId: "SF123",
              trackingUrl: "https://steadfast.com.bd/t/SF123",
            },
          },
        ],
      },
    });
  });

  it("clears OTP KV state when queue handoff fails", async () => {
    const app = createTestApp();
    const queueSend = vi.fn().mockRejectedValue(new Error("queue down"));
    const kvDelete = vi.fn().mockResolvedValue(undefined);
    mocks.sendOtp.mockResolvedValue({
      success: true,
      message: "Verification code sent to your email",
      otpStorageKey: "cust_otp:buyer@example.com",
      queuePayload: {
        type: "auth.send_otp",
        deliveryKey: "otp_delivery_1",
        purpose: "customer_login",
        otpExpiresAt: 4_102_444_800,
        method: "email",
        allowedMethod: "email",
        identifier: "buyer@example.com",
        code: "123456",
        name: "Buyer",
      },
    });

    const response = await app.request(
      "/api/v1/customer-auth/send-otp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "email",
          identifier: "Buyer@Example.com",
          name: "Buyer",
        }),
      },
      {
        CACHE: { delete: kvDelete },
        AUTH_OTP_QUEUE: { send: queueSend },
      } as never,
    );

    expect(response.status).toBe(503);
    expect(queueSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_1",
    }));
    expect(kvDelete).toHaveBeenCalledWith("cust_otp:buyer@example.com");
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
      },
    });
  });
});
