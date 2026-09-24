// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  shouldRejectCrossOriginCookieRequest: vi.fn(),
}));

vi.mock("@/lib/api/transport", () => ({
  apiFetch: mocks.apiFetch,
}));

vi.mock("@scalius/shared/request-origin-guard", () => ({
  shouldRejectCrossOriginCookieRequest: mocks.shouldRejectCrossOriginCookieRequest,
}));

import { accountOwnerReceiptRedirect } from "../../order-lookup-api";
import { POST as sendCode } from "../../../pages/api/payment-recovery/send-code";
import { POST as verifyCode } from "../../../pages/api/payment-recovery/verify";
import { getOrderReceiptCookieName } from "../../order-receipt-cookie";

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(false);
});

describe("payment recovery storefront proxies", () => {
  it("says where the code went and the short order number, never the full contact", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        message: "We sent a code to 01•••••888.",
        destination: "01•••••888",
        orderNumber: 1048,
        resendAfterSeconds: 60,
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await sendCode({
      request: new Request("https://storefront.example.test/api/payment-recovery/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1" }),
      }),
    } as never);
    const json = await response.json() as Record<string, unknown>;
    const [apiPath, requestInit, policy] = mocks.apiFetch.mock.calls[0]!;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json).toEqual({
      success: true,
      sent: true,
      message: "We sent a code to 01•••••888.",
      orderNumber: 1048,
      resendAfterSeconds: 60,
    });
    expect(JSON.stringify(json)).not.toContain("01775528888");
    expect(JSON.stringify(json)).not.toContain("chk_");
    expect(apiPath).toBe("/orders/payment-recovery/send-otp");
    expect(JSON.parse(String(requestInit.body))).toEqual({ orderId: "order_1" });
    expect(policy).toEqual({ retries: 0, timeout: 8000, auth: false });
  });

  it("answers a neutral send without a code step", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: { message: "If this order still needs an online payment, we've sent a code to the phone number or email saved on it." },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const response = await sendCode({
      request: new Request("https://storefront.example.test/api/payment-recovery/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_fake" }),
      }),
    } as never);

    expect(await response.json()).toMatchObject({ success: true, sent: false, orderNumber: null });
  });

  it("keeps provider detail on the server", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Provider detail that must not be buyer-facing",
      },
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await sendCode({
      request: new Request("https://storefront.example.test/api/payment-recovery/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1" }),
      }),
    } as never);
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(json).toEqual({ success: false, errorCode: "SERVICE_UNAVAILABLE" });
    expect(JSON.stringify(json)).not.toContain("Provider detail");
  });

  it("sets the receipt cookie on verified recovery without returning the token in JSON", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
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
        body: JSON.stringify({ orderId: "order_1", code: "123456" }),
      }),
    } as never);
    const json = await response.json() as Record<string, unknown>;
    const [apiPath, requestInit, policy] = mocks.apiFetch.mock.calls[0]!;
    const cookie = response.headers.get("Set-Cookie") ?? "";

    expect(response.status).toBe(200);
    expect(apiPath).toBe("/orders/payment-recovery/verify-otp");
    expect(JSON.parse(String(requestInit.body))).toEqual({ orderId: "order_1", code: "123456" });
    expect(policy).toEqual({ retries: 0, timeout: 8000, auth: true });
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
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
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
        body: JSON.stringify({ orderId: "order_1", code: "000000" }),
      }),
    } as never);
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(json).toEqual({ success: false, errorCode: "VALIDATION_ERROR" });
    expect(JSON.stringify(json)).not.toContain("could not be verified");
  });

  it("passes the wait with its sentence, and the attempts left without backend copy", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: { code: "RATE_LIMIT", message: "Too many codes.", details: { retryAfterSeconds: 45 } },
    }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "45" } }));
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "That code isn't right.", details: { attemptsLeft: 1 } },
    }), { status: 400, headers: { "Content-Type": "application/json" } }));

    const limited = await sendCode({
      request: new Request("https://storefront.example.test/api/payment-recovery/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1" }),
      }),
    } as never);
    const wrong = await verifyCode({
      request: new Request("https://storefront.example.test/api/payment-recovery/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", code: "000000" }),
      }),
    } as never);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("45");
    expect(await limited.json()).toEqual({ success: false, errorCode: "RATE_LIMIT", message: "Too many codes.", retryAfterSeconds: 45 });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ success: false, errorCode: "VALIDATION_ERROR", attemptsLeft: 1 });
  });

  it("sends a signed-in owner straight to the receipt with a private proof cookie", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { receiptToken: "chk_owner" } })));

    const response = await accountOwnerReceiptRedirect(
      "order_1",
      "cs_tok=session_1; other=1",
      new URLSearchParams({ orderId: "order_1", payment: "sslcommerz", result: "failed" }),
    );
    const [apiPath, init] = mocks.apiFetch.mock.calls[0]!;

    expect(apiPath).toBe("/orders/receipt/order_1/owner-proof");
    expect(new Headers(init.headers).get("X-Customer-Session")).toBe("session_1");
    expect(response?.status).toBe(303);
    expect(response?.headers.get("Location")).toBe("/order-success?orderId=order_1&payment=sslcommerz&result=failed");
    expect(response?.headers.get("Set-Cookie")).toContain(`${getOrderReceiptCookieName("order_1")}=chk_owner`);
  });

  it("keeps the code form for a visitor who isn't the signed-in owner", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 404 }));

    expect(await accountOwnerReceiptRedirect("order_1", null, new URLSearchParams())).toBeNull();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(await accountOwnerReceiptRedirect("order_1", "cs_tok=someone_else", new URLSearchParams())).toBeNull();
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
        body: JSON.stringify({ orderId: "order_1", code: "123456" }),
      }),
    } as never);

    expect(response.status).toBe(403);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});
