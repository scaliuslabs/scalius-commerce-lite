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

vi.mock("../../generated/agent-operations.gen", async (importOriginal) => {
  const generated = await importOriginal<
    typeof import("../../generated/agent-operations.gen")
  >();
  const { buildAgentWorkflowCatalog } = await import("../workflows/catalog");
  return {
    ...generated,
    AGENT_WORKFLOW_CATALOG: buildAgentWorkflowCatalog(generated.AGENT_OPERATIONS, {
      requireCuratedCards: true,
    }),
  };
});

import { AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import type { AgentPrincipal } from "../types";
import { DASHBOARD_AGENT_WORKFLOW_ROUTES } from "../workflows/routes-dashboard";
import { executeAuthorizedWorkflowRead } from "./workflow-read";

const DAILY_PROMPT = "dashboard.daily-operations-snapshot";
const THIRTY_DAY_PROMPT = "dashboard.thirty-day-booked-operations-brief";
const DAILY_RULES = [
  "Interpret activity.daily.bookedRevenue as Asia/Dhaka order-day booked gross, not collected cash, profit, or net settlement.",
  "No authoritative merchant-day collected-cash or net-settlement aggregate exists; report it unavailable, never zero or inferred.",
  "activity.paymentRecovery.total is all recoverable hosted-payment work; activity.paymentNeedsAttention.total is the actionable failed/stale subset; both are current non-transactional backlogs, not daily metrics.",
  "Never subtract the recovery totals because their parallel reads can observe different instants.",
  "Fail closed when fulfillment, stock, checkout, payment, delivery, or currency facts cannot be read.",
  "Any requested field absent from fixed selectors is unavailable; never infer or claim coverage.",
];
const THIRTY_DAY_RULES = DASHBOARD_AGENT_WORKFLOW_ROUTES.find((route) =>
  route.id === THIRTY_DAY_PROMPT
)!.rules;
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
    "dashboard.orders.payment_recovery_list": {
      data: {
        orders: [{
          id: "rec_private",
          customerName: "Recovery Buyer",
          customerPhone: "+8801900000000",
          shippingAddress: "Hidden recovery address",
        }],
        pagination: { page: 1, limit: 1, total: 7, totalPages: 7 },
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

function thirtyDayData(): Record<string, unknown> {
  return {
    "dashboard.home.activity": {
      data: {
        dailyActivityData: Array.from({ length: 30 }, (_, index) => ({
          date: new Date(Date.UTC(2026, 6, 20 + index)).toISOString().slice(0, 10),
          orders: index === 4 ? 0 : index,
          revenue: index === 4 ? 0 : index * 100,
          customerEmail: `private-${index}@example.com`,
        })),
      },
    },
    "dashboard.settings.currency_get": {
      data: { currencyCode: "BDT", currencySymbol: "৳", providerSecret: "hidden" },
    },
    "dashboard.inventory.list": {
      data: {
        stats: { lowStockCount: 6, outOfStockCount: 3 },
        variants: [{ sku: "PRIVATE-SKU", customerPhone: "+8801700000000" }],
      },
    },
    "dashboard.abandoned_checkouts.summaries_list": {
      data: {
        pagination: { page: 1, limit: 1, total: 11, totalPages: 11 },
        checkouts: [{ email: "abandoned@example.com", phone: "+8801800000000" }],
      },
    },
    "dashboard.orders.payment_recovery_list": {
      data: {
        pagination: { page: 1, limit: 1, total: 8, totalPages: 8 },
        orders: [{ customerName: "Recovery Buyer", customerEmail: "recovery@example.com" }],
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
      input,
    }: {
      operation: AgentOperationManifestEntry;
      input: { query?: { state?: string } };
    }) => {
      expect(authorizedIds).toHaveLength(8);
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
      if (
        operation.operationId === "dashboard.orders.payment_recovery_list" &&
        input.query?.state === "needs_attention"
      ) {
        return operationResult(operation.operationId, {
          data: {
            orders: [{ customerEmail: "attention-private@example.com" }],
            pagination: { page: 1, limit: 1, total: 2, totalPages: 2 },
          },
        });
      }
      return operationResult(operation.operationId, responses[operation.operationId]);
    });

    const result = await execute();

    expect(maxActive).toBe(2);
    expect(completionOrder[0]).toBe("dashboard.settings.currency_get");
    expect(mocks.getAuthorizedOperation).toHaveBeenCalledTimes(8);
    expect(mocks.getAuthorizedOperation.mock.calls.map(([operationId]) => operationId)).toEqual([
      "dashboard.home.activity",
      "dashboard.settings.currency_get",
      "dashboard.orders.list",
      "dashboard.orders.payment_recovery_list",
      "dashboard.inventory_alerts.list",
      "dashboard.checkout.readiness_get",
      "dashboard.payments.methods_get",
      "dashboard.shipping_methods.list",
    ]);
    expect(mocks.dispatchAgentOperation).toHaveBeenCalledTimes(9);
    expect(result).toEqual({
      kind: "result",
      disposition: "execute",
      version: "3.0.0",
      workflowId: "operations.daily-snapshot.v1",
      rules: DAILY_RULES,
      outputs: {
        "activity.daily": {
          activity: [{
            date: "2026-08-18",
            orders: 4,
            bookedRevenue: 9200,
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
        "activity.paymentRecovery": { total: 7 },
        "activity.paymentNeedsAttention": { total: 2 },
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
      "activity.paymentRecovery",
      "activity.paymentNeedsAttention",
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
      "Recovery Buyer",
      "+8801900000000",
      "Hidden recovery address",
      "attention-private@example.com",
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
      "dashboard.orders.payment_recovery_list": {
        query: { page: 1, limit: 1, state: "needs_attention" },
      },
      "dashboard.inventory_alerts.list": { query: { status: "active" } },
      "dashboard.checkout.readiness_get": {},
      "dashboard.payments.methods_get": {},
      "dashboard.shipping_methods.list": {
        query: { page: 1, limit: 100, sort: "sortOrder", order: "asc" },
      },
    });
    expect(mocks.dispatchAgentOperation.mock.calls.filter(([options]) =>
      options.operation.operationId === "dashboard.orders.payment_recovery_list"
    ).map(([options]) => options.input)).toEqual([
      { query: { page: 1, limit: 1, state: "recoverable" } },
      { query: { page: 1, limit: 1, state: "needs_attention" } },
    ]);
  });

  it("executes the fixed 30-day brief in three two-lane waves with count-only outputs", async () => {
    const responses = thirtyDayData();
    const authorized: string[] = [];
    let active = 0;
    let maxActive = 0;
    let wave = 0;
    const startedWaves: number[] = [];
    mocks.getAuthorizedOperation.mockImplementation(async (operationId: string) => {
      authorized.push(operationId);
      return AGENT_OPERATIONS_BY_ID[operationId] ?? null;
    });
    mocks.dispatchAgentOperation.mockImplementation(async ({
      operation,
      input,
    }: {
      operation: AgentOperationManifestEntry;
      input: { query?: { state?: string } };
    }) => {
      expect(authorized).toHaveLength(5);
      if (active === 0) wave += 1;
      startedWaves.push(wave);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (
        operation.operationId === "dashboard.orders.payment_recovery_list" &&
        input.query?.state === "needs_attention"
      ) {
        return operationResult(operation.operationId, {
          data: {
            pagination: { page: 1, limit: 1, total: 3, totalPages: 3 },
            orders: [{ customerPhone: "+8801900000000" }],
          },
        });
      }
      return operationResult(operation.operationId, responses[operation.operationId]);
    });

    const result = await execute(THIRTY_DAY_PROMPT);

    expect(authorized).toEqual([
      "dashboard.home.activity",
      "dashboard.settings.currency_get",
      "dashboard.inventory.list",
      "dashboard.abandoned_checkouts.summaries_list",
      "dashboard.orders.payment_recovery_list",
    ]);
    expect(maxActive).toBe(2);
    expect(startedWaves).toEqual([1, 1, 2, 2, 3, 3]);
    expect(mocks.dispatchAgentOperation).toHaveBeenCalledTimes(6);
    expect(result).toMatchObject({
      kind: "result",
      disposition: "execute",
      workflowId: "operations.thirty-day-booked-brief.v1",
      rules: THIRTY_DAY_RULES,
      outputs: {
        "brief.currency": { currencyCode: "BDT", currencySymbol: "৳" },
        "brief.stock": { lowStockCount: 6, outOfStockCount: 3 },
        "brief.abandoned": { total: 11 },
        "brief.paymentRecovery": { total: 8 },
        "brief.paymentNeedsAttention": { total: 3 },
      },
    });
    if (result.kind !== "result") return;
    expect(Object.keys(result.outputs)).toEqual([
      "brief.daily",
      "brief.currency",
      "brief.stock",
      "brief.abandoned",
      "brief.paymentRecovery",
      "brief.paymentNeedsAttention",
    ]);
    expect(result.outputs["brief.daily"]?.activity).toHaveLength(30);
    const activity = result.outputs["brief.daily"]?.activity as Array<Record<string, unknown>>;
    expect(activity[0]?.date).toBe("2026-07-20");
    expect(activity.at(-1)?.date).toBe("2026-08-18");
    expect(activity[4])
      .toEqual({ date: "2026-07-24", orders: 0, bookedRevenue: 0 });
    const serialized = JSON.stringify(result);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(8 * 1024);
    for (const forbidden of [
      "private-",
      "PRIVATE-SKU",
      "+8801700000000",
      "abandoned@example.com",
      "Recovery Buyer",
      "recovery@example.com",
      "+8801900000000",
      "providerSecret",
      '"orders":[',
      '"checkouts":[',
    ]) expect(serialized).not.toContain(forbidden);

    expect(mocks.dispatchAgentOperation.mock.calls.map(([options]) => options.input)).toEqual([
      { query: { days: 30 } },
      {},
      {
        query: {
          section: "variants",
          page: 1,
          limit: 1,
          search: "",
          status: "all",
          sort: "available",
          order: "asc",
        },
      },
      { query: { page: 1, limit: 1, search: "", order: "desc" } },
      { query: { page: 1, limit: 1, state: "recoverable", order: "desc" } },
      { query: { page: 1, limit: 1, state: "needs_attention", order: "desc" } },
    ]);
  });

  it.each([
    ["dispatch failure", 2],
    ["missing currency projection", 2],
    ["29 activity rows", 2],
    ["31 activity rows", 2],
    ["missing abandoned total", 4],
    ["later recovery failure", 6],
    ["PII-bearing operation error", 6],
  ] as const)(
    "fails the whole 30-day brief without partial outputs or zeros on %s",
    async (failure, expectedCalls) => {
      const responses = thirtyDayData();
      mocks.dispatchAgentOperation.mockImplementation(async ({
        operation,
        input,
      }: {
        operation: AgentOperationManifestEntry;
        input: { query?: { state?: string } };
      }) => {
        if (failure === "dispatch failure" && operation.operationId === "dashboard.home.activity") {
          throw new Error("read failed");
        }
        if (
          failure === "missing currency projection" &&
          operation.operationId === "dashboard.settings.currency_get"
        ) {
          return operationResult(operation.operationId, { data: { currencyCode: "BDT" } });
        }
        if (
          (failure === "29 activity rows" || failure === "31 activity rows") &&
          operation.operationId === "dashboard.home.activity"
        ) {
          const dailyActivityData = (responses[operation.operationId] as {
            data: { dailyActivityData: Array<Record<string, unknown>> };
          }).data.dailyActivityData;
          return operationResult(operation.operationId, {
            data: {
              dailyActivityData: failure === "29 activity rows"
                ? dailyActivityData.slice(0, 29)
                : [
                    ...dailyActivityData,
                    { ...dailyActivityData.at(-1)!, date: "2026-08-19" },
                  ],
            },
          });
        }
        if (
          failure === "missing abandoned total" &&
          operation.operationId === "dashboard.abandoned_checkouts.summaries_list"
        ) {
          return operationResult(operation.operationId, {
            data: {
              pagination: { page: 1, limit: 1, totalPages: 1 },
              checkouts: [{ email: "must-not-leak@example.com" }],
            },
          });
        }
        if (
          failure === "later recovery failure" &&
          operation.operationId === "dashboard.orders.payment_recovery_list" &&
          input.query?.state === "needs_attention"
        ) {
          throw new Error("late read failed");
        }
        if (
          failure === "PII-bearing operation error" &&
          operation.operationId === "dashboard.orders.payment_recovery_list" &&
          input.query?.state === "needs_attention"
        ) {
          return {
            operationId: operation.operationId,
            status: 500,
            ok: false,
            requestId: "private-request-buyer@example.com",
            contentType: "application/json",
            data: { customerEmail: "must-not-leak@example.com" },
          };
        }
        return operationResult(operation.operationId, responses[operation.operationId]);
      });

      const result = await execute(THIRTY_DAY_PROMPT);

      expect(result).toEqual(UNAVAILABLE);
      expect(JSON.stringify(result)).not.toContain('"outputs"');
      expect(JSON.stringify(result)).not.toContain('"total":0');
      expect(JSON.stringify(result)).not.toContain('"disposition":"unsupported"');
      expect(JSON.stringify(result)).not.toContain("must-not-leak");
      expect(JSON.stringify(result)).not.toContain("private-request");
      expect(mocks.dispatchAgentOperation).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it("authorizes every unique operation before dispatch and returns no grant details on denial", async () => {
    mocks.getAuthorizedOperation.mockImplementation(async (operationId: string) =>
      operationId === "dashboard.shipping_methods.list"
        ? null
        : AGENT_OPERATIONS_BY_ID[operationId] ?? null
    );

    const result = await execute();

    expect(result).toEqual(UNAVAILABLE);
    expect(mocks.getAuthorizedOperation).toHaveBeenCalledTimes(8);
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
    expect(mocks.dispatchAgentOperation).toHaveBeenCalledTimes(9);
  });
});
