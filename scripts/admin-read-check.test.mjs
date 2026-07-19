import { describe, expect, it, vi } from "vitest";
import {
  buildAdminRoutePlan,
  classifyAdminRouteState,
  getAdminReadCheckConfig,
  runAdminReadCheck,
} from "./admin-read-check.mjs";

const config = {
  dashboardBaseUrl: "https://dashboard.example.test",
  timeoutMs: 5_000,
  email: "operator@example.test",
  password: "not-printed-password",
};

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function authResponse() {
  return jsonResponse(
    { user: { id: "not-reported" }, twoFactorRedirect: false },
    200,
    { "set-cookie": "better-auth.session_token=session-secret; Path=/; HttpOnly; Secure" },
  );
}

function inventoryResponse(total = 1) {
  return jsonResponse({
    success: true,
    data: {
      variants: total > 0 ? [{ id: "variant-secret", sku: "sku-secret" }] : [],
      pagination: { page: 1, limit: 1, total, totalPages: total > 0 ? 1 : 0 },
    },
  });
}

function ordersResponse(total = 1) {
  return jsonResponse({
    success: true,
    data: {
      orders: total > 0 ? [{ id: "order-secret", customerName: "Private Customer" }] : [],
      pagination: { page: 1, limit: 1, total, totalPages: total > 0 ? 1 : 0 },
    },
  });
}

function detailResponse() {
  return jsonResponse({
    success: true,
    data: {
      id: "order-secret",
      customerName: "Private Customer",
      items: [{ id: "item-secret" }],
      paymentRecovery: { state: "none" },
      shipmentRecovery: { activeLock: false },
      activeRefundOperation: null,
    },
  });
}

function orderFormResponse() {
  return jsonResponse({
    success: true,
    data: {
      productsWithVariants: [{
        id: "product-secret",
        variants: [{ id: "variant-secret", selectedOptions: [] }],
      }],
      defaultValues: { items: [{ id: "item-secret" }] },
    },
  });
}

function productsResponse(total = 1) {
  return jsonResponse({
    success: true,
    data: {
      products: total > 0 ? [{ id: "product-secret", name: "Private Product" }] : [],
      pagination: { page: 1, limit: 1, total, totalPages: total > 0 ? 1 : 0 },
    },
  });
}

function customersResponse(total = 1) {
  return jsonResponse({
    success: true,
    data: {
      customers: total > 0 ? [{ id: "customer-secret", name: "Private Customer" }] : [],
      pagination: { page: 1, limit: 1, total, totalPages: total > 0 ? 1 : 0 },
    },
  });
}

function customerHistoryResponse() {
  return jsonResponse({
    success: true,
    data: {
      customer: { id: "customer-secret", name: "Private Customer" },
      history: [{ id: "history-secret" }],
      orders: [{ id: "order-secret" }],
    },
  });
}

function signOutResponse(status = 200) {
  return jsonResponse(status === 200 ? { success: true } : { error: "private" }, status);
}

function sequenceFetch(responses) {
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch");
    return response;
  });
}

const passedBrowserEvidence = {
  status: "passed",
  checkedCount: 23,
  skippedCount: 0,
  checks: [{ label: "order_edit", status: "passed" }],
  skipped: [],
  consoleErrorCount: 0,
  pageErrorCount: 0,
};

function runCheck(fetchImpl, browserRouteCheckImpl = vi.fn(async () => passedBrowserEvidence)) {
  return runAdminReadCheck(config, { fetchImpl, browserRouteCheckImpl });
}

describe("authenticated admin read check", () => {
  it("fails safely when authentication fails", async () => {
    const fetchImpl = sequenceFetch([jsonResponse({ error: { message: "private" } }, 401)]);

    await expect(runCheck(fetchImpl)).rejects.toThrow(
      "Admin sign-in failed with HTTP 401",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cleans up a session when a successful auth response is unusable", async () => {
    const fetchImpl = sequenceFetch([
      new Response("not-json", {
        status: 200,
        headers: { "set-cookie": "better-auth.session_token=session-secret; Path=/; HttpOnly" },
      }),
      signOutResponse(),
    ]);

    let failure;
    try {
      await runCheck(fetchImpl);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: "Admin sign-in response was not valid JSON.",
      sessionCleanup: { status: "passed", acknowledged: true },
    });
    expect(new URL(fetchImpl.mock.calls[1][0]).pathname).toBe("/api/auth/sign-out");
  });

  it("fails on an inventory 500 without attempting later reads", async () => {
    const fetchImpl = sequenceFetch([
      authResponse(),
      jsonResponse({ error: { message: "database details must stay private" } }, 500),
      signOutResponse(),
    ]);

    let failure;
    try {
      await runCheck(fetchImpl);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message: expect.stringContaining("Inventory variants GET failed with HTTP 500"),
      sessionCleanup: { status: "passed", statusCode: 200, acknowledged: true },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new URL(fetchImpl.mock.calls[2][0]).pathname).toBe("/api/auth/sign-out");
    expect(fetchImpl.mock.calls[2][1]).toMatchObject({
      method: "POST",
      body: "{}",
      headers: {
        "content-type": "application/json",
        cookie: "better-auth.session_token=session-secret",
      },
    });
  });

  it("treats an empty order catalog as truthful and skips detail", async () => {
    const fetchImpl = sequenceFetch([
      authResponse(),
      inventoryResponse(0),
      ordersResponse(0),
      productsResponse(0),
      customersResponse(0),
      signOutResponse(),
    ]);

    const result = await runCheck(fetchImpl);

    expect(result).toMatchObject({
      status: "passed",
      readOnly: true,
      orders: { totalCount: 0, returnedCount: 0, empty: true },
      detail: { status: "skipped_empty_orders" },
      orderForm: { status: "skipped_empty_orders" },
      products: { totalCount: 0, empty: true },
      customers: { totalCount: 0, empty: true },
      customerHistory: { status: "skipped_empty_customers" },
      sessionCleanup: { status: "passed", statusCode: 200, acknowledged: true },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("fails when the bounded order detail returns 500", async () => {
    const fetchImpl = sequenceFetch([
      authResponse(),
      inventoryResponse(),
      ordersResponse(),
      jsonResponse({ error: { message: "private timeout details" } }, 500),
      signOutResponse(),
    ]);

    let failure;
    try {
      await runCheck(fetchImpl);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message: expect.stringContaining("Order detail GET failed with HTTP 500"),
      sessionCleanup: { status: "passed", statusCode: 200, acknowledged: true },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(new URL(fetchImpl.mock.calls[4][0]).pathname).toBe("/api/auth/sign-out");
  });

  it("fails before the browser when order edit form-data omits a variant collection", async () => {
    const fetchImpl = sequenceFetch([
      authResponse(),
      inventoryResponse(),
      ordersResponse(),
      detailResponse(),
      jsonResponse({
        success: true,
        data: {
          productsWithVariants: [{ id: "product-secret" }],
          defaultValues: { items: [] },
        },
      }),
      signOutResponse(),
    ]);

    let failure;
    try {
      await runCheck(fetchImpl);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: "Order form-data GET response included a product without variants.",
      sessionCleanup: { status: "passed", acknowledged: true },
    });
    expect(new URL(fetchImpl.mock.calls[5][0]).pathname).toBe("/api/auth/sign-out");
  });

  it("fails before the browser when an order form variant omits selectedOptions", async () => {
    const fetchImpl = sequenceFetch([
      authResponse(),
      inventoryResponse(),
      ordersResponse(),
      detailResponse(),
      jsonResponse({
        success: true,
        data: {
          productsWithVariants: [{
            id: "product-secret",
            variants: [{ id: "variant-secret" }],
          }],
          defaultValues: { items: [] },
        },
      }),
      signOutResponse(),
    ]);

    let failure;
    try {
      await runCheck(fetchImpl);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: "Order form-data GET response included a variant without selectedOptions.",
      sessionCleanup: { status: "passed", acknowledged: true },
    });
    expect(new URL(fetchImpl.mock.calls[5][0]).pathname).toBe("/api/auth/sign-out");
  });

  it("passes bounded reads, reuses the in-memory cookie, and emits only safe evidence", async () => {
    const fetchImpl = sequenceFetch([
      authResponse(),
      inventoryResponse(3),
      ordersResponse(2),
      detailResponse(),
      orderFormResponse(),
      productsResponse(4),
      customersResponse(3),
      customerHistoryResponse(),
      signOutResponse(),
    ]);

    const result = await runCheck(fetchImpl);

    expect(result).toMatchObject({
      status: "passed",
      readOnly: true,
      auth: { statusCode: 200, sessionCookieCount: 1 },
      inventory: { statusCode: 200, returnedCount: 1, totalCount: 3 },
      orders: { statusCode: 200, returnedCount: 1, totalCount: 2, empty: false },
      detail: {
        status: "passed",
        statusCode: 200,
        itemCount: 1,
        hasShipmentRecoveryLock: false,
        hasActiveRefundOperation: false,
      },
      orderForm: { status: "passed", productCount: 1, itemCount: 1 },
      products: { returnedCount: 1, totalCount: 4, empty: false },
      customers: { returnedCount: 1, totalCount: 3, empty: false },
      customerHistory: { status: "passed", historyCount: 1, orderCount: 1 },
      browser: { status: "passed", checkedCount: 23 },
      sessionCleanup: { status: "passed", statusCode: 200, acknowledged: true },
    });

    const calls = fetchImpl.mock.calls;
    expect(calls.map(([, init]) => init.method)).toEqual([
      "POST",
      "GET",
      "GET",
      "GET",
      "GET",
      "GET",
      "GET",
      "GET",
      "POST",
    ]);
    expect(calls.slice(1).every(([, init]) => init.headers.cookie === "better-auth.session_token=session-secret")).toBe(true);
    expect(new URL(calls[1][0]).searchParams.get("limit")).toBe("1");
    expect(new URL(calls[2][0]).searchParams.get("limit")).toBe("1");
    expect(new URL(calls[4][0]).pathname).toBe("/api/v1/admin/orders/order-secret/form-data");
    expect(new URL(calls[8][0]).pathname).toBe("/api/auth/sign-out");

    const evidence = JSON.stringify(result);
    for (const privateValue of [
      config.email,
      config.password,
      "session-secret",
      "variant-secret",
      "sku-secret",
      "order-secret",
      "Private Customer",
      "item-secret",
      "product-secret",
      "customer-secret",
      "history-secret",
      "Private Product",
    ]) {
      expect(evidence).not.toContain(privateValue);
    }
  });

  it("surfaces sign-out failure as safe warning evidence after successful reads", async () => {
    const fetchImpl = sequenceFetch([
      authResponse(),
      inventoryResponse(),
      ordersResponse(),
      detailResponse(),
      orderFormResponse(),
      productsResponse(),
      customersResponse(),
      customerHistoryResponse(),
      signOutResponse(500),
    ]);

    const result = await runCheck(fetchImpl);

    expect(result).toMatchObject({
      status: "passed_with_warning",
      sessionCleanup: {
        status: "warning",
        statusCode: 500,
        acknowledged: false,
        message: "Admin sign-out returned HTTP 500.",
      },
      warnings: ["Admin sign-out returned HTTP 500."],
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("session-secret");
  });

  it("preserves a browser route failure and still attempts session cleanup", async () => {
    const fetchImpl = sequenceFetch([
      authResponse(),
      inventoryResponse(),
      ordersResponse(),
      detailResponse(),
      orderFormResponse(),
      productsResponse(),
      customersResponse(),
      customerHistoryResponse(),
      signOutResponse(),
    ]);
    const browserRouteCheckImpl = vi.fn(async () => {
      throw new Error("Authenticated admin route order_edit failed: page_exception.");
    });

    let failure;
    try {
      await runCheck(fetchImpl, browserRouteCheckImpl);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: "Authenticated admin route order_edit failed: page_exception.",
      sessionCleanup: { status: "passed", acknowledged: true },
    });
    expect(browserRouteCheckImpl).toHaveBeenCalledOnce();
    expect(new URL(fetchImpl.mock.calls[8][0]).pathname).toBe("/api/auth/sign-out");
  });

  it("preserves a primary read failure when sign-out also fails", async () => {
    const fetchImpl = sequenceFetch([
      authResponse(),
      jsonResponse({ error: { message: "private inventory failure" } }, 500),
      signOutResponse(503),
    ]);

    let failure;
    try {
      await runCheck(fetchImpl);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: "Inventory variants GET failed with HTTP 500.",
      sessionCleanup: {
        status: "warning",
        statusCode: 503,
        acknowledged: false,
        message: "Admin sign-out returned HTTP 503.",
      },
    });
    expect(failure.message).not.toContain("private");
  });

  it("requires credentials from environment and rejects credential flags", () => {
    expect(() => getAdminReadCheckConfig([], {})).toThrow("SCALIUS_ADMIN_READ_EMAIL");
    expect(() => getAdminReadCheckConfig(["--email", "leak@example.test"], {})).toThrow(
      "only through process environment",
    );
    expect(() => getAdminReadCheckConfig(["--browser"], {
      SCALIUS_ADMIN_READ_EMAIL: "operator@example.test",
      SCALIUS_ADMIN_READ_PASSWORD: "secret",
    })).toThrow("Option --browser requires a value");
    expect(getAdminReadCheckConfig([], {
      SCALIUS_ADMIN_READ_EMAIL: "operator@example.test",
      SCALIUS_ADMIN_READ_PASSWORD: "secret",
      SCALIUS_DASHBOARD_BASE_URL: "https://dashboard.example.test",
      SCALIUS_ADMIN_READ_BROWSER: "/path/to/chrome",
    })).toMatchObject({
      dashboardBaseUrl: "https://dashboard.example.test",
      browserExecutable: "/path/to/chrome",
      email: "operator@example.test",
      password: "secret",
    });
  });

  it("builds bounded dynamic route coverage and truthful empty-resource skips", () => {
    const complete = buildAdminRoutePlan({
      orderId: "order-secret",
      productId: "product-secret",
      customerId: "customer-secret",
    });
    expect(complete.routes.map((route) => route.label)).toEqual(expect.arrayContaining([
      "orders_new",
      "order_view",
      "order_edit",
      "product_view",
      "product_edit",
      "customer_edit",
      "customer_history",
      "media",
      "settings_seo",
      "settings_security",
      "settings_theme",
      "settings_notifications",
    ]));
    expect(complete.skipped).toEqual([]);

    const empty = buildAdminRoutePlan();
    expect(empty.skipped).toEqual(expect.arrayContaining([
      { label: "order_edit", reason: "empty_orders" },
      { label: "product_edit", reason: "empty_products" },
      { label: "customer_history", reason: "empty_customers" },
    ]));
  });

  it("classifies redirects, route fallbacks, and browser runtime errors without exposing payloads", () => {
    const base = {
      expectedPathname: "/admin/orders/private-id/edit",
      actualPathname: "/admin/orders/private-id/edit",
      expectedTitle: "Edit Order #",
      actualTitle: "Edit Order #private-id | Scalius Admin",
    };
    expect(classifyAdminRouteState(base)).toBeNull();
    expect(classifyAdminRouteState({
      ...base,
      actualPathname: "/admin/orders",
    })).toBe("unexpected_redirect");
    expect(classifyAdminRouteState({
      ...base,
      bodyText: "Order editor could not be loaded. Cannot read properties of undefined.",
    })).toBe("error_fallback");
    expect(classifyAdminRouteState({ ...base, pageErrorCount: 1 })).toBe("page_exception");
    expect(classifyAdminRouteState({ ...base, consoleErrorCount: 1 })).toBe("console_error");
    expect(classifyAdminRouteState({
      expectedPathname: "/admin/settings",
      actualPathname: "/admin/settings/",
      expectedSearch: { section: "seo" },
      actualSearch: "?section=security",
      expectedTitle: "General Settings",
      actualTitle: "General Settings | Scalius Admin",
    })).toBe("unexpected_redirect");
  });
});
