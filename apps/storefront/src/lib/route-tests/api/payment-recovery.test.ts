// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiUrl: vi.fn((path: string) => `https://api.example.test/api/v1${path}`),
  fetchWithRetry: vi.fn(),
  shouldRejectCrossOriginCookieRequest: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  createApiUrl: mocks.createApiUrl,
  fetchWithRetry: mocks.fetchWithRetry,
}));

vi.mock("@scalius/shared/request-origin-guard", () => ({
  shouldRejectCrossOriginCookieRequest: mocks.shouldRejectCrossOriginCookieRequest,
}));

import { POST as sendCode } from "../../../pages/api/payment-recovery/send-code";
import { POST as verifyCode } from "../../../pages/api/payment-recovery/verify";
import { getOrderReceiptCookieName } from "../../order-receipt-cookie";

beforeEach(() => {
  mocks.createApiUrl.mockClear();
  mocks.fetchWithRetry.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(false);
});

describe("payment recovery storefront proxies", () => {
  it("requests a code through the public API without exposing contact hints", async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        message: "If this order is eligible for payment recovery, a verification code will be sent to the buyer contact.",
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await sendCode({
      request: new Request("https://storefront.example.test/api/payment-recovery/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", channel: "sms" }),
      }),
    } as never);
    const json = await response.json() as Record<string, unknown>;
    const [, requestInit, retries, timeout, requiresAuth] = mocks.fetchWithRetry.mock.calls[0]!;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json).toEqual({
      success: true,
      resultCode: "PAYMENT_RECOVERY_CODE_REQUEST_ACCEPTED",
    });
    expect(JSON.stringify(json)).not.toContain("01775528888");
    expect(JSON.stringify(json)).not.toContain("chk_");
    expect(mocks.createApiUrl).toHaveBeenCalledWith("/orders/payment-recovery/send-otp");
    expect(JSON.parse(String(requestInit.body))).toEqual({ orderId: "order_1", channel: "sms" });
    expect(retries).toBe(0);
    expect(timeout).toBe(8000);
    expect(requiresAuth).toBe(false);
  });

  it("returns stable error classification without forwarding backend copy", async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Provider detail that must not be buyer-facing",
      },
    }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await sendCode({
      request: new Request("https://storefront.example.test/api/payment-recovery/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", channel: "sms" }),
      }),
    } as never);
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(429);
    expect(json).toEqual({ success: false, errorCode: "RATE_LIMIT_EXCEEDED" });
    expect(JSON.stringify(json)).not.toContain("Provider detail");
  });

  it("sets the receipt cookie on verified recovery without returning the token in JSON", async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
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
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await verifyCode({
      request: new Request("https://storefront.example.test/api/payment-recovery/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", channel: "sms", code: "123456" }),
      }),
    } as never);
    const json = await response.json() as Record<string, unknown>;
    const [, requestInit, retries, timeout, requiresAuth] = mocks.fetchWithRetry.mock.calls[0]!;
    const cookie = response.headers.get("Set-Cookie") ?? "";

    expect(response.status).toBe(200);
    expect(mocks.createApiUrl).toHaveBeenCalledWith("/orders/payment-recovery/verify-otp");
    expect(JSON.parse(String(requestInit.body))).toEqual({
      orderId: "order_1",
      channel: "sms",
      code: "123456",
    });
    expect(retries).toBe(0);
    expect(timeout).toBe(8000);
    expect(requiresAuth).toBe(true);
    expect(json).toEqual({
      success: true,
      redirectUrl: "/order-success?orderId=order_1&payment=sslcommerz&result=failed&paymentType=deposit&depositAmount=60",
    });
    expect(JSON.stringify(json)).not.toContain("chk_private_recovery");
    expect(cookie).toContain(`${getOrderReceiptCookieName("order_1")}=chk_private_recovery`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("classifies verification failures without forwarding backend copy", async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Verification code could not be verified. Please request a new code.",
      },
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await verifyCode({
      request: new Request("https://storefront.example.test/api/payment-recovery/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", channel: "sms", code: "000000" }),
      }),
    } as never);
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(json).toEqual({ success: false, errorCode: "VALIDATION_ERROR" });
    expect(JSON.stringify(json)).not.toContain("could not be verified");
  });

  it("rejects cross-origin cookie writes before backend work", async () => {
    mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(true);

    const response = await verifyCode({
      request: new Request("https://storefront.example.test/api/payment-recovery/verify", {
        method: "POST",
        headers: {
          Origin: "https://evil.example.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ orderId: "order_1", channel: "sms", code: "123456" }),
      }),
    } as never);

    expect(response.status).toBe(403);
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });
});
