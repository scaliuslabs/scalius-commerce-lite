import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@scalius/core/errors";

const mocks = vi.hoisted(() => ({
  sendOrderPaymentRecoveryOtp: vi.fn(),
  verifyOrderPaymentRecoveryOtp: vi.fn(),
  deleteOrderPaymentRecoveryChallenge: vi.fn(),
}));

vi.mock("@scalius/core/modules/orders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/orders")>();
  return {
    ...actual,
    sendOrderPaymentRecoveryOtp: mocks.sendOrderPaymentRecoveryOtp,
    verifyOrderPaymentRecoveryOtp: mocks.verifyOrderPaymentRecoveryOtp,
    deleteOrderPaymentRecoveryChallenge: mocks.deleteOrderPaymentRecoveryChallenge,
  };
});

vi.mock("../middleware/auth", async () => {
  const { UnauthorizedError } = await import("../utils/api-error");
  return {
    authMiddleware: async (c: { req: { header: (name: string) => string | undefined } }, next: () => Promise<void>) => {
      if (!c.req.header("Authorization")) {
        throw new UnauthorizedError("Authentication required");
      }
      await next();
    },
  };
});

import { errorResponseFromError } from "../utils/api-response";
import { orderRoutes } from "./orders";

const db = { id: "db" };

function createTestApp() {
  const queue = {
    send: vi.fn(async (_payload: unknown) => undefined),
  };
  const env = {
    AUTH_OTP_QUEUE: queue,
    CREDENTIAL_ENCRYPTION_KEY: "test-credential-key",
    JWT_SECRET: "test-jwt-secret",
    PUBLIC_API_BASE_URL: "http://localhost:8787",
    STOREFRONT_URL: "http://localhost:4322",
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/orders", orderRoutes);

  return { app, env, queue };
}

describe("order payment recovery routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendOrderPaymentRecoveryOtp.mockResolvedValue({
      queued: true,
      message: "Verification code sent.",
      channel: "sms",
      method: "phone",
      identifierMasked: "*******8888",
      challengeKey: "order_payrec:challenge",
      deliveryKey: "otp_delivery",
      queuePayload: {
        type: "auth.send_otp",
        deliveryKey: "otp_delivery",
        purpose: "order_payment_recovery",
        method: "phone",
        allowedMethod: "sms_otp",
        channel: "sms",
        identifier: "+8801775528888",
        name: "Buyer",
      },
    });
    mocks.verifyOrderPaymentRecoveryOtp.mockResolvedValue({
      orderId: "order_1",
      receiptToken: "chk_private_recovery",
      expiresAt: 1_765_000_000,
      gateway: "sslcommerz",
      paymentType: "deposit",
      depositAmount: 60,
      redirectParams: {
        payment: "sslcommerz",
        result: "failed",
        paymentType: "deposit",
        depositAmount: 60,
      },
    });
    mocks.deleteOrderPaymentRecoveryChallenge.mockResolvedValue(undefined);
  });

  it("accepts a recovery OTP request without exposing proof or contact hints", async () => {
    const { app, env, queue } = createTestApp();

    const response = await app.request(
      "/api/v1/orders/payment-recovery/send-otp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.10",
        },
        body: JSON.stringify({ orderId: "order_1", channel: "sms" }),
      },
      env,
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "order_payment_recovery",
      deliveryKey: "otp_delivery",
    }));
    expect(mocks.sendOrderPaymentRecoveryOtp).toHaveBeenCalledWith(db, expect.objectContaining({
      orderId: "order_1",
      channel: "sms",
      ip: "203.0.113.10",
      encryptionKey: "test-credential-key",
    }));
    expect(JSON.stringify(body)).not.toContain("chk_");
    expect(JSON.stringify(body)).not.toContain("+8801775528888");
    expect(JSON.stringify(body)).not.toContain("8888");
    expect(JSON.stringify(queue.send.mock.calls)).not.toContain("123456");
    const queuedPayload = queue.send.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(queuedPayload).not.toHaveProperty("code");
    expect(body).toMatchObject({
      success: true,
      data: {
        message: "If this order is eligible for payment recovery, a verification code will be sent to the buyer contact.",
      },
    });
  });

  it("keeps validation failures enumeration-safe", async () => {
    const { app, env, queue } = createTestApp();
    mocks.sendOrderPaymentRecoveryOtp.mockRejectedValueOnce(
      new ValidationError("That verification channel is not available for this order."),
    );

    const response = await app.request(
      "/api/v1/orders/payment-recovery/send-otp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "missing_order", channel: "email" }),
      },
      env,
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(queue.send).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("not available");
  });

  it("deletes the pending challenge when queue handoff fails", async () => {
    const { app, env, queue } = createTestApp();
    queue.send.mockRejectedValueOnce(new Error("queue unavailable"));

    const response = await app.request(
      "/api/v1/orders/payment-recovery/send-otp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", channel: "sms" }),
      },
      env,
    );

    expect(response.status).toBe(503);
    expect(mocks.deleteOrderPaymentRecoveryChallenge).toHaveBeenCalledWith(db, {
      challengeKey: "order_payrec:challenge",
      deliveryKey: "otp_delivery",
    });
  });

  it("requires service auth before issuing a receipt token", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/orders/payment-recovery/verify-otp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", channel: "sms", code: "123456" }),
      },
      env,
    );

    expect(response.status).toBe(401);
    expect(mocks.verifyOrderPaymentRecoveryOtp).not.toHaveBeenCalled();
  });

  it("issues receipt proof only to an authenticated storefront server caller", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/orders/payment-recovery/verify-otp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer service.jwt",
        },
        body: JSON.stringify({ orderId: "order_1", channel: "sms", code: "123456" }),
      },
      env,
    );
    const body = await response.json() as { data?: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(mocks.verifyOrderPaymentRecoveryOtp).toHaveBeenCalledWith(db, {
      orderId: "order_1",
      channel: "sms",
      code: "123456",
      encryptionKey: "test-credential-key",
    });
    expect(body.data?.receiptToken).toBe("chk_private_recovery");
  });
});
