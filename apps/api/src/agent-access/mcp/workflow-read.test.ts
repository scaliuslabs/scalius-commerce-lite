import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthorizedOperation: vi.fn(),
  dispatchAgentOperation: vi.fn(),
}));

vi.mock("./operations", () => ({
  getAuthorizedOperation: mocks.getAuthorizedOperation,
}));

vi.mock("../dispatch", () => ({
  dispatchAgentOperation: mocks.dispatchAgentOperation,
}));

import { AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import type { AgentPrincipal } from "../types";
import { executeAuthorizedWorkflowRead } from "./workflow-read";

const DAILY_PROMPT = "dashboard.daily-operations-snapshot";
const UNAVAILABLE = {
  kind: "unavailable",
  disposition: "unavailable",
  classification: {
    code: "workflow_read_unavailable",
    reason: "The requested workflow read is unavailable.",
  },
};

const principal: AgentPrincipal = {
  kind: "agent",
  grantId: "grant_read",
  credentialId: "credential_read",
  ownerUserId: "owner_1",
  isSuperAdmin: false,
  resource: "dashboard",
  grantKind: "oauth",
  preset: "read",
  permissions: new Set(["orders:read", "settings:read"]),
  riskCeiling: "read",
  authorityRevision: 3,
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
};
const env = {} as Env;
const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

function dailyData(): Record<string, unknown> {
  return {
    "dashboard.home.activity": {
      data: {
        dailyActivityData: [
          {
            date: "2026-08-18",
            orders: 4,
            revenue: 9200,
            newCustomers: 2,
            customerEmail: "hidden-activity@example.com",
          },
        ],
        requestId: "hidden-inner-request",
      },
    },
    "dashboard.settings.currency_get": {
      data: {
        currencyCode: "BDT",
        currencySymbol: "৳",
        privateGatewayKey: "hidden-currency-secret",
      },
    },
    "dashboard.orders.list": {
      data: {
        orders: [
          {
            id: "ord_1",
            totalAmount: 2500,
            status: "processing",
            paymentStatus: "paid",
            paymentMethod: "sslcommerz",
            fulfillmentStatus: "pending",
            createdAt: "2026-08-18T04:30:00.000Z",
            itemCount: 2,
            totalQuantity: 3,
            customerName: "Private Buyer",
            email: "buyer@example.com",
            phone: "+8801700000000",
            shippingAddress: { line1: "Private address" },
          },
        ],
        pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
      },
    },
    "dashboard.inventory_alerts.list": {
      data: {
        alerts: [
          {
            productId: "prod_1",
            productName: "Black T-shirt",
            variantId: "var_1",
            variantSku: "TS-BLK-M",
            variantLabel: "Black / M",
            currentQty: 2,
            threshold: 5,
            alertStatus: "active",
            supplierPhone: "+8801800000000",
          },
        ],
      },
    },
    "dashboard.checkout.readiness_get": {
      data: {
        ready: true,
        hasActiveShippingMethod: true,
        hasActiveDeliveryHierarchy: true,
        customerSignInRequired: false,
        hasUsableCustomerSignIn: true,
        issues: ["payment_gateway_degraded"],
        merchantEmail: "hidden-merchant@example.com",
      },
    },
    "dashboard.payments.methods_get": {
      data: {
        enabledMethods: ["sslcommerz", "cod"],
        activeMethods: ["sslcommerz", "cod"],
        defaultMethod: "sslcommerz",
        activeDefaultMethod: "sslcommerz",
        gatewayStatus: {
          stripe: {
            configured: false,
            usable: false,
            checkoutVisible: false,
            secretKey: "sk_hidden",
          },
          sslcommerz: {
            configured: true,
            usable: true,
            checkoutVisible: true,
            storePassword: "hidden-password",
          },
          polar: { configured: false, usable: false, checkoutVisible: false },
          cod: { configured: true, usable: true, checkoutVisible: true },
        },
      },
    },
    "dashboard.shipping_methods.list": {
      data: {
        shippingMethods: [
          {
            id: "ship_1",
            name: "Inside Dhaka",
            fee: 80,
            isActive: true,
            sortOrder: 1,
            internalProviderToken: "hidden-shipping-token",
          },
        ],
        pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
      },
    },
  };
}

function operationResult(operationId: string, data: unknown) {
  return {
    operationId,
    status: 200,
    ok: true,
    requestId: `request-${operationId}`,
    contentType: "application/json",
    data,
  };
}

function execute(prompt = DAILY_PROMPT) {
  return executeAuthorizedWorkflowRead({
    prompt,
    surface: "dashboard",
    principal,
    env,
    ctx,
  });
}

describe("executeAuthorizedWorkflowRead", () => {
  beforeEach(() => {
    mocks.getAuthorizedOperation.mockReset().mockImplementation(
      async (operationId: string) => AGENT_OPERATIONS_BY_ID[operationId] ?? null,
    );
    mocks.dispatchAgentOperation.mockReset();
  });

  it("preflights all reads, keeps two lanes, applies fixed inputs, and returns only exact projections", async () => {
    const responses = dailyData();
    const authorizedIds: string[] = [];
    let active = 0;
    let maxActive = 0;
    const completionOrder: string[] = [];
    mocks.getAuthorizedOperation.mockImplementation(async (operationId: string) => {
      authorizedIds.push(operationId);
      return AGENT_OPERATIONS_BY_ID[operationId] ?? null;
    });
    mocks.dispatchAgentOperation.mockImplementation(async ({
      operation,
    }: {
      operation: AgentOperationManifestEntry;
    }) => {
      expect(authorizedIds).toHaveLength(7);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const slow = [
        "dashboard.home.activity",
        "dashboard.inventory_alerts.list",
        "dashboard.payments.methods_get",
      ].includes(operation.operationId);
      await new Promise((resolve) => setTimeout(resolve, slow ? 4 : 1));
      active -= 1;
      completionOrder.push(operation.operationId);
      return operationResult(operation.operationId, responses[operation.operationId]);
    });

    const result = await execute();

    expect(maxActive).toBe(2);
    expect(completionOrder[0]).toBe("dashboard.settings.currency_get");
    expect(mocks.getAuthorizedOperation).toHaveBeenCalledTimes(7);
    expect(mocks.getAuthorizedOperation.mock.calls.map(([operationId]) => operationId)).toEqual([
      "dashboard.home.activity",
      "dashboard.settings.currency_get",
      "dashboard.orders.list",
      "dashboard.inventory_alerts.list",
      "dashboard.checkout.readiness_get",
      "dashboard.payments.methods_get",
      "dashboard.shipping_methods.list",
    ]);
    expect(mocks.dispatchAgentOperation).toHaveBeenCalledTimes(7);
    expect(result).toEqual({
      kind: "result",
      disposition: "execute",
      version: "3.0.0",
      workflowId: "operations.daily-snapshot.v1",
      outputs: {
        "activity.daily": {
          activity: [{
            date: "2026-08-18",
            orders: 4,
            revenue: 9200,
            newCustomers: 2,
          }],
        },
        "activity.currency": { currencyCode: "BDT", currencySymbol: "৳" },
        "activity.fulfillment": {
          orderQueue: [{
            id: "ord_1",
            totalAmount: 2500,
            status: "processing",
            paymentStatus: "paid",
            paymentMethod: "sslcommerz",
            fulfillmentStatus: "pending",
            createdAt: "2026-08-18T04:30:00.000Z",
            itemCount: 2,
            totalQuantity: 3,
          }],
          pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
        },
        "readiness.alerts": {
          inventoryAlerts: [{
            productId: "prod_1",
            productName: "Black T-shirt",
            variantId: "var_1",
            sku: "TS-BLK-M",
            variant: "Black / M",
            quantity: 2,
            threshold: 5,
            status: "active",
          }],
        },
        "readiness.checkout": {
          ready: true,
          hasActiveShippingMethod: true,
          hasActiveDeliveryHierarchy: true,
          customerSignInRequired: false,
          hasUsableCustomerSignIn: true,
          issues: ["payment_gateway_degraded"],
        },
        "readiness.payments": {
          enabledMethods: ["sslcommerz", "cod"],
          activeMethods: ["sslcommerz", "cod"],
          defaultMethod: "sslcommerz",
          activeDefaultMethod: "sslcommerz",
          gatewayStatus: {
            stripeConfigured: false,
            stripeUsable: false,
            stripeVisible: false,
            sslConfigured: true,
            sslUsable: true,
            sslVisible: true,
            polarConfigured: false,
            polarUsable: false,
            polarVisible: false,
            codConfigured: true,
            codUsable: true,
            codVisible: true,
          },
        },
        "readiness.delivery": {
          shippingMethods: [{
            id: "ship_1",
            name: "Inside Dhaka",
            fee: 80,
            isActive: true,
            sortOrder: 1,
          }],
          pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
        },
      },
    });
    expect(Object.keys(result.kind === "result" ? result.outputs : {})).toEqual([
      "activity.daily",
      "activity.currency",
      "activity.fulfillment",
      "readiness.alerts",
      "readiness.checkout",
      "readiness.payments",
      "readiness.delivery",
    ]);
    const serialized = JSON.stringify(result);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(64 * 1024);
    for (const forbidden of [
      "Private Buyer",
      "buyer@example.com",
      "+8801700000000",
      "Private address",
      "hidden-password",
      "hidden-shipping-token",
      "request-dashboard",
      "statusGroup",
    ]) expect(serialized).not.toContain(forbidden);

    const calls = Object.fromEntries(mocks.dispatchAgentOperation.mock.calls.map(([options]) => [
      options.operation.operationId,
      options.input,
    ]));
    expect(calls).toEqual({
      "dashboard.home.activity": { query: { days: 1 } },
      "dashboard.settings.currency_get": {},
      "dashboard.orders.list": {
        query: {
          page: 1,
          limit: 10,
          statusGroup: "open",
          fulfillmentStatus: "pending",
          sort: "createdAt",
          order: "desc",
        },
      },
      "dashboard.inventory_alerts.list": { query: { status: "active" } },
      "dashboard.checkout.readiness_get": {},
      "dashboard.payments.methods_get": {},
      "dashboard.shipping_methods.list": {
        query: { page: 1, limit: 100, sort: "sortOrder", order: "asc" },
      },
    });
  });

  it("authorizes every unique operation before dispatch and returns no grant details on denial", async () => {
    mocks.getAuthorizedOperation.mockImplementation(async (operationId: string) =>
      operationId === "dashboard.shipping_methods.list"
        ? null
        : AGENT_OPERATIONS_BY_ID[operationId] ?? null
    );

    const result = await execute();

    expect(result).toEqual(UNAVAILABLE);
    expect(mocks.getAuthorizedOperation).toHaveBeenCalledTimes(7);
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("shipping_methods");
    expect(JSON.stringify(result)).not.toContain("grant_read");

    mocks.getAuthorizedOperation.mockReset().mockImplementation(async (operationId: string) => {
      const operation = AGENT_OPERATIONS_BY_ID[operationId];
      return operation ? { ...operation, openWorld: true } : null;
    });
    expect(await execute()).toEqual(UNAVAILABLE);
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
  });

  it("rejects write, cross-surface, non-card, and unrelated resolutions without dispatch", async () => {
    for (const prompt of [
      "dashboard.complex-product-create",
      "What are today's sales and order count? Be clear about what sales means.",
      "quantum aardvark unicycle",
    ]) {
      expect(await execute(prompt)).toEqual(UNAVAILABLE);
    }
    expect(mocks.getAuthorizedOperation).not.toHaveBeenCalled();
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();

    const storefrontPrincipal = { ...principal, resource: "storefront" as const };
    expect(await executeAuthorizedWorkflowRead({
      prompt: DAILY_PROMPT,
      surface: "storefront",
      principal: storefrontPrincipal,
      env,
      ctx,
    })).toEqual(UNAVAILABLE);
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
  });

  it("fails closed on operation failure or projection mismatch without returning partial data", async () => {
    const responses = dailyData();
    mocks.dispatchAgentOperation.mockImplementation(async ({
      operation,
    }: {
      operation: AgentOperationManifestEntry;
    }) => operation.operationId === "dashboard.orders.list"
      ? { ...operationResult(operation.operationId, null), ok: false, status: 503 }
      : operationResult(operation.operationId, responses[operation.operationId]));
    expect(await execute()).toEqual(UNAVAILABLE);

    mocks.dispatchAgentOperation.mockImplementation(async ({
      operation,
    }: {
      operation: AgentOperationManifestEntry;
    }) => {
      const data = dailyData();
      if (operation.operationId === "dashboard.inventory_alerts.list") {
        data[operation.operationId] = { data: { alerts: [{ productId: "prod_1" }] } };
      }
      return operationResult(operation.operationId, data[operation.operationId]);
    });
    expect(await execute()).toEqual(UNAVAILABLE);
  });

  it("rejects a projected result at or above the 64 KiB boundary", async () => {
    const responses = dailyData();
    const shipping = responses["dashboard.shipping_methods.list"] as {
      data: { shippingMethods: Array<Record<string, unknown>> };
    };
    shipping.data.shippingMethods = Array.from({ length: 100 }, (_, index) => ({
      id: `ship_${index}`,
      name: "x".repeat(800),
      fee: 80,
      isActive: true,
      sortOrder: index,
    }));
    mocks.dispatchAgentOperation.mockImplementation(async ({
      operation,
    }: {
      operation: AgentOperationManifestEntry;
    }) => operationResult(operation.operationId, responses[operation.operationId]));

    expect(await execute()).toEqual(UNAVAILABLE);
    expect(mocks.dispatchAgentOperation).toHaveBeenCalledTimes(7);
  });
});
