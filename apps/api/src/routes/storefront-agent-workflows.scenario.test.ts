import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  createContext: vi.fn(),
  mutateCart: vi.fn(),
  quote: vi.fn(),
  submit: vi.fn(),
  receipt: vi.fn(),
  createContinuation: vi.fn(),
  continuationStatus: vi.fn(),
  profile: vi.fn(),
  orders: vi.fn(),
  support: vi.fn(),
  orderAccess: vi.fn(),
  refreshPayment: vi.fn(),
  postCommit: vi.fn(),
  enqueueSupport: vi.fn(),
}));

vi.mock("@scalius/core/modules/agent-storefront", () => ({
  closeAgentStorefrontContext: vi.fn(),
  createAgentStorefrontContext: mocks.createContext,
  getAgentStorefrontContext: vi.fn(),
  getAgentStorefrontCart: vi.fn(),
  mutateAgentStorefrontCart: mocks.mutateCart,
  setAgentStorefrontDiscount: vi.fn(),
  setAgentStorefrontDelivery: vi.fn(),
  validateAgentStorefrontCheckout: vi.fn(),
  quoteAgentStorefrontCheckout: mocks.quote,
  submitAgentStorefrontCheckout: mocks.submit,
  createAgentStorefrontContinuation: mocks.createContinuation,
  getAgentStorefrontContinuationStatus: mocks.continuationStatus,
  logoutAgentStorefrontCustomer: vi.fn(),
  getAgentStorefrontCustomerProfile: mocks.profile,
  updateAgentStorefrontCustomerProfile: vi.fn(),
  listAgentStorefrontCustomerOrders: mocks.orders,
  getAgentStorefrontCustomerOrder: vi.fn(),
  getAgentStorefrontOrderAccess: mocks.orderAccess,
  getAgentStorefrontReceipt: mocks.receipt,
  createAgentStorefrontOrderSupportRequest: mocks.support,
  refreshAgentStorefrontPaymentContinuation: mocks.refreshPayment,
}));

vi.mock("@scalius/core/modules/orders", () => ({
  getOrderSupportRequestStatusLabel: vi.fn(() => "Pending"),
  runStorefrontOrderPostCommitSideEffects: mocks.postCommit,
}));

vi.mock("../utils/order-notification-queue", () => ({
  enqueueOrderSupportRequestNotificationForOrder: mocks.enqueueSupport,
}));

import { storefrontAgentContextRoutes } from "./storefront-agent-contexts";

const contextId = "asc_12345678901234567890";
const continuationId = "acn_12345678901234567890";
const continuationCode = `acb_12345678901234567890_${"s".repeat(43)}`;
const orderId = "order_scenario_1";

function contextView(revision = 1) {
  const timestamp = "2026-08-13T00:00:00.000Z";
  return {
    id: contextId,
    status: "active",
    revision,
    cart: [],
    discountCode: null,
    delivery: { cityId: null, zoneId: null, areaId: null, shippingMethodId: null },
    customerAuthorized: false,
    expiresAt: timestamp,
    lastUsedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function app() {
  const testApp = new OpenAPIHono<{ Bindings: Env }>();
  testApp.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  testApp.use("*", async (c, next) => {
    c.set("db", {} as never);
    c.set("agentPrincipal", {
      kind: "agent",
      credentialId: "acr_test",
      grantId: "agr_test",
      grantKind: "pat",
      ownerUserId: "user_test",
      isSuperAdmin: true,
      resource: "storefront",
      preset: "full",
      permissions: new Set(),
      riskCeiling: "financial",
      authorityRevision: 1,
      expiresAt: new Date("2026-08-14T00:00:00.000Z"),
    });
    await next();
  });
  testApp.route("/storefront/agent-contexts", storefrontAgentContextRoutes);
  return testApp;
}

async function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  return app().request(`https://api.example.test${path}`, init, {
    PUBLIC_API_BASE_URL: "https://api.example.test",
    STOREFRONT_URL: "https://shop.example.test",
    ORDER_NOTIFICATIONS_QUEUE: { send: vi.fn() },
  } as unknown as Env);
}

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await rawRequest(path, init);
  expect(response.status).toBeLessThan(400);
  return response.json() as Promise<Record<string, unknown>>;
}

function checkoutBody(idempotencyKey?: string): Record<string, unknown> {
  return {
    expectedRevision: 2,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    customerName: "Scenario Buyer",
    customerPhone: "+8801700000000",
    customerEmail: null,
    shippingAddress: "Scenario delivery address",
    notes: null,
    paymentMethod: "cod",
  };
}

describe("storefront agent buyer workflow scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createContext.mockResolvedValue(contextView());
    mocks.mutateCart.mockResolvedValue({ context: contextView(2), valid: true, issues: [], items: [], subtotal: 25, hasFreeDeliveryProduct: false });
    mocks.quote.mockResolvedValue({ valid: true, contextRevision: 2, totalAmount: 30 });
    mocks.submit.mockResolvedValue({
      response: { status: "complete", contextRevision: 3, orderId, paymentMethod: "cod", message: "Cash-on-delivery order created." },
      postCommitPayload: null,
      availabilityVariantIds: [],
    });
    mocks.receipt.mockResolvedValue({ id: orderId, status: "pending", paymentMethod: "cod", totalAmount: 30, items: [] });
    mocks.createContinuation.mockImplementation(async (_db, _grant, _context, input: { kind: string }) => ({
      id: continuationId,
      kind: input.kind,
      status: "pending",
      expiresAt: "2026-08-13T00:30:00.000Z",
      bootstrapCode: continuationCode,
    }));
    mocks.continuationStatus.mockResolvedValue({
      id: continuationId,
      kind: "customer_auth",
      status: "complete",
      expiresAt: "2026-08-13T00:30:00.000Z",
      result: { authenticated: true },
      message: "The secure storefront step is complete.",
    });
    mocks.profile.mockResolvedValue({ customerId: "cust_1", name: "Buyer", phone: "+8801700000000" });
    mocks.orders.mockResolvedValue({ orders: [{ id: orderId }], nextCursor: null });
    mocks.orderAccess.mockResolvedValue({ kind: "grant" });
    mocks.support.mockResolvedValue({ request: { id: "osr_1", type: "return", label: "Return", status: "pending" } });
    mocks.refreshPayment.mockResolvedValue(undefined);
    mocks.enqueueSupport.mockResolvedValue(undefined);
  });

  it("moves cart authority through quote and COD commit to a safe receipt", async () => {
    await request("/storefront/agent-contexts", { method: "POST" });
    await request(`/storefront/agent-contexts/${contextId}/cart/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: 1, variantId: "variant_1", quantity: 1 }),
    });
    await request(`/storefront/agent-contexts/${contextId}/checkout/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const checkout = await request(`/storefront/agent-contexts/${contextId}/checkout/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(checkoutBody("scenario_checkout_0001")),
    });
    const receipt = await request(`/storefront/agent-contexts/${contextId}/orders/${orderId}/receipt`);
    expect(checkout).toMatchObject({ success: true, data: { orderId, contextRevision: 3 } });
    expect(receipt).toMatchObject({ success: true, data: { id: orderId, paymentMethod: "cod" } });
    expect(JSON.stringify([checkout, receipt])).not.toMatch(/chk_|cst_|receiptToken|clientSecret/);
  });

  it.each(["stripe", "sslcommerz", "polar"])(
    "accepts the reviewed %s order method before the secure payment continuation",
    async (paymentMethod) => {
      mocks.submit.mockResolvedValueOnce({
        response: {
          status: "complete",
          contextRevision: 3,
          orderId,
          paymentMethod,
          message: "Order created. Start secure payment with storefront.orders.payment.begin.",
        },
        postCommitPayload: null,
        availabilityVariantIds: [],
      });
      const response = await request(`/storefront/agent-contexts/${contextId}/checkout/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...checkoutBody(`scenario_${paymentMethod}_0001`), paymentMethod }),
      });
      expect(response).toMatchObject({ success: true, data: { orderId, paymentMethod } });
      expect(mocks.submit).toHaveBeenCalledWith(
        expect.anything(),
        "agr_test",
        contextId,
        expect.objectContaining({ paymentMethod }),
        expect.anything(),
      );
    },
  );

  it("replays a header-only checkout with one canonical idempotency key", async () => {
    const idempotencyKey = "scenario_header_retry_0001";
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(checkoutBody()),
    };

    const first = await request(`/storefront/agent-contexts/${contextId}/checkout/submit`, init);
    const retry = await request(`/storefront/agent-contexts/${contextId}/checkout/submit`, init);

    expect(retry).toEqual(first);
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect(mocks.submit.mock.calls.map((call) => call[3].idempotencyKey)).toEqual([
      idempotencyKey,
      idempotencyKey,
    ]);
  });

  it("rejects missing or mismatched checkout idempotency keys before checkout authority", async () => {
    const path = `/storefront/agent-contexts/${contextId}/checkout/submit`;
    const missing = await rawRequest(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(checkoutBody()),
    });
    const mismatch = await rawRequest(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "scenario_header_mismatch_01",
      },
      body: JSON.stringify(checkoutBody("scenario_body_mismatch_0001")),
    });

    expect(missing.status).toBe(400);
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Idempotency-Key header must match body.idempotencyKey.",
      },
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("completes hosted customer authorization before account and support actions", async () => {
    const begin = await request(`/storefront/agent-contexts/${contextId}/customer/auth`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const status = await request(`/storefront/agent-contexts/${contextId}/customer/auth/${continuationId}`);
    const profile = await request(`/storefront/agent-contexts/${contextId}/customer/profile`);
    const orders = await request(`/storefront/agent-contexts/${contextId}/customer/orders`);
    const support = await request(`/storefront/agent-contexts/${contextId}/orders/${orderId}/support-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "return", reason: "Item is not suitable", message: null }),
    });
    expect(begin).toMatchObject({
      success: true,
      data: {
        browser: {
          url: "https://shop.example.test/agent/continue",
          method: "POST",
          fields: { continuationCode },
        },
      },
    });
    expect(status).toMatchObject({ success: true, data: { status: "complete" } });
    expect(profile).toMatchObject({ success: true, data: { customerId: "cust_1" } });
    expect(orders).toMatchObject({ success: true, data: { orders: [{ id: orderId }] } });
    expect(support).toMatchObject({ success: true, data: { request: { id: "osr_1" } } });
  });

  it("returns only safe hosted payment and recovery lifecycle state", async () => {
    const payment = await request(`/storefront/agent-contexts/${contextId}/orders/${orderId}/payment`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const pendingPayment = {
      id: continuationId, kind: "payment", status: "pending", expiresAt: "2026-08-13T00:30:00.000Z", result: null, message: "Complete securely.",
    };
    mocks.continuationStatus.mockResolvedValueOnce(pendingPayment).mockResolvedValueOnce(pendingPayment);
    const paymentStatus = await request(`/storefront/agent-contexts/${contextId}/payments/${continuationId}`);
    const recovery = await request(`/storefront/agent-contexts/${contextId}/orders/${orderId}/payment-recovery`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    mocks.continuationStatus.mockResolvedValueOnce({
      id: continuationId, kind: "payment_recovery", status: "complete", expiresAt: "2026-08-13T00:30:00.000Z", result: { recovered: true, orderId }, message: "Complete.",
    });
    const recoveryStatus = await request(`/storefront/agent-contexts/${contextId}/payment-recoveries/${continuationId}`);
    expect(payment).toMatchObject({
      success: true,
      data: { kind: "payment", browser: { url: "https://shop.example.test/agent/continue", method: "POST" } },
    });
    expect(paymentStatus).toMatchObject({ success: true, data: { kind: "payment", status: "pending" } });
    expect(recovery).toMatchObject({
      success: true,
      data: { kind: "payment_recovery", browser: { url: "https://shop.example.test/agent/continue", method: "POST" } },
    });
    expect(recoveryStatus).toMatchObject({ success: true, data: { kind: "payment_recovery", result: { recovered: true } } });
    expect(JSON.stringify([payment, paymentStatus, recovery, recoveryStatus])).not.toMatch(/otp|chk_|cst_|receiptProof|clientSecret|sessionKey/i);
  });
});
