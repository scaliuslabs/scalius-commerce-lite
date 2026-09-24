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

import { POST as sendCode } from "../../../pages/api/order-lookup/send-code";
import { POST as verifyCode } from "../../../pages/api/order-lookup/verify";
import { getOrderReceiptCookieName } from "../../order-receipt-cookie";

function apiResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function post(path: string, body: unknown) {
  return {
    request: new Request(`https://storefront.example.test/api/order-lookup/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  } as never;
}

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(false);
});

describe("order lookup send-code proxy", () => {
  it("sends the normalised order number and phone to the public API", async () => {
    mocks.apiFetch.mockResolvedValueOnce(apiResponse({
      success: true,
      data: {
        message: "If these details match an order, we've sent a code to the phone number or email saved on it.",
        resendAfterSeconds: 45,
      },
    }));

    const response = await sendCode(post("send-code", { reference: "#১০০১", phone: "০১৭১২ ৩৪৫৬৭৮" }));
    const [apiPath, init, policy] = mocks.apiFetch.mock.calls[0]!;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, resendAfterSeconds: 45 });
    expect(apiPath).toBe("/orders/lookup/send-otp");
    expect(JSON.parse(String(init.body))).toEqual({ reference: "1001", phone: "+8801712345678" });
    expect(policy).toEqual({ retries: 0, timeout: 8000, auth: false });
  });

  it("rejects an unusable phone before calling the API", async () => {
    const response = await sendCode(post("send-code", { reference: "1001", phone: "12345" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, errorCode: "VALIDATION_ERROR", field: "phone" });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("passes a rate-limit wait through as seconds and a Retry-After header", async () => {
    mocks.apiFetch.mockResolvedValueOnce(apiResponse({
      success: false,
      error: { code: "RATE_LIMIT", message: "Too many codes requested.", details: { retryAfterSeconds: 120 } },
    }, 429, { "Retry-After": "120" }));

    const response = await sendCode(post("send-code", { reference: "1001", phone: "01712345678" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    expect(await response.json()).toEqual({
      success: false,
      errorCode: "RATE_LIMIT",
      message: "Too many codes requested.",
      retryAfterSeconds: 120,
    });
  });

  it("reads the wait from Retry-After when the body has none", async () => {
    mocks.apiFetch.mockResolvedValueOnce(apiResponse({ success: false, error: { code: "RATE_LIMIT" } }, 429, {
      "Retry-After": "30",
    }));

    const response = await sendCode(post("send-code", { reference: "1001", phone: "01712345678" }));

    expect(await response.json()).toMatchObject({ retryAfterSeconds: 30 });
  });

  it("keeps an unavailable store distinct", async () => {
    mocks.apiFetch.mockResolvedValueOnce(apiResponse({
      success: false,
      error: { code: "SERVICE_UNAVAILABLE", message: "Order tracking isn't available right now. Contact the store." },
    }, 503));

    const response = await sendCode(post("send-code", { reference: "1001", phone: "01712345678" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ errorCode: "SERVICE_UNAVAILABLE" });
  });

  it("rejects cross-origin posts before any backend work", async () => {
    mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(true);

    const response = await sendCode(post("send-code", { reference: "1001", phone: "01712345678" }));

    expect(response.status).toBe(403);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});

describe("order lookup verify proxy", () => {
  it("stores the receipt proof as an httpOnly cookie and never returns it", async () => {
    mocks.apiFetch.mockResolvedValueOnce(apiResponse({
      success: true,
      data: { orderId: "JJEHCFQ3C1JJ35GX", receiptToken: "chk_private_lookup", expiresAt: 1_765_000_000 },
    }));

    const response = await verifyCode(post("verify", { reference: "#1001", phone: "01712345678", code: "123456" }));
    const body = await response.json() as Record<string, unknown>;
    const [apiPath, init, policy] = mocks.apiFetch.mock.calls[0]!;
    const cookie = response.headers.get("Set-Cookie") ?? "";

    expect(response.status).toBe(200);
    expect(apiPath).toBe("/orders/lookup/verify-otp");
    expect(JSON.parse(String(init.body))).toEqual({ reference: "1001", phone: "+8801712345678", code: "123456" });
    expect(policy).toEqual({ retries: 0, timeout: 8000, auth: true });
    expect(body).toEqual({ success: true, redirectUrl: "/order-success?orderId=JJEHCFQ3C1JJ35GX" });
    expect(JSON.stringify(body)).not.toContain("chk_");
    expect(cookie).toContain(`${getOrderReceiptCookieName("JJEHCFQ3C1JJ35GX")}=chk_private_lookup`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("passes the attempts left on a wrong code", async () => {
    mocks.apiFetch.mockResolvedValueOnce(apiResponse({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "That code isn't right. Check it and try again.", details: { attemptsLeft: 1 } },
    }, 400));

    const response = await verifyCode(post("verify", { reference: "1001", phone: "01712345678", code: "000000" }));

    expect(response.status).toBe(400);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.json()).toEqual({
      success: false,
      errorCode: "VALIDATION_ERROR",
      message: "That code isn't right. Check it and try again.",
      attemptsLeft: 1,
    });
  });

  it("refuses a success without a receipt proof", async () => {
    mocks.apiFetch.mockResolvedValueOnce(apiResponse({ success: true, data: { orderId: "JJEHCFQ3C1JJ35GX" } }));

    const response = await verifyCode(post("verify", { reference: "1001", phone: "01712345678", code: "123456" }));

    expect(response.status).toBe(502);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.json()).toEqual({ success: false, errorCode: "ORDER_LOOKUP_RECEIPT_UNAVAILABLE" });
  });

  it("asks for the code before calling the API", async () => {
    const response = await verifyCode(post("verify", { reference: "1001", phone: "01712345678", code: "" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, errorCode: "VALIDATION_ERROR", field: "code" });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("rejects cross-origin cookie writes before any backend work", async () => {
    mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(true);

    const response = await verifyCode(post("verify", { reference: "1001", phone: "01712345678", code: "123456" }));

    expect(response.status).toBe(403);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});
