import { describe, expect, it, vi } from "vitest";
import {
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

describe("authenticated admin read check", () => {
  it("fails safely when authentication fails", async () => {
    const fetchImpl = sequenceFetch([jsonResponse({ error: { message: "private" } }, 401)]);

    await expect(runAdminReadCheck(config, { fetchImpl })).rejects.toThrow(
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
      await runAdminReadCheck(config, { fetchImpl });
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
      await runAdminReadCheck(config, { fetchImpl });
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
      headers: { cookie: "better-auth.session_token=session-secret" },
    });
  });

  it("treats an empty order catalog as truthful and skips detail", async () => {
    const fetchImpl = sequenceFetch([
      authResponse(),
      inventoryResponse(0),
      ordersResponse(0),
      signOutResponse(),
    ]);

    const result = await runAdminReadCheck(config, { fetchImpl });

    expect(result).toMatchObject({
      status: "passed",
      readOnly: true,
      orders: { totalCount: 0, returnedCount: 0, empty: true },
      detail: { status: "skipped_empty_orders" },
      sessionCleanup: { status: "passed", statusCode: 200, acknowledged: true },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
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
      await runAdminReadCheck(config, { fetchImpl });
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

  it("passes bounded reads, reuses the in-memory cookie, and emits only safe evidence", async () => {
    const fetchImpl = sequenceFetch([
      authResponse(),
      inventoryResponse(3),
      ordersResponse(2),
      detailResponse(),
      signOutResponse(),
    ]);

    const result = await runAdminReadCheck(config, { fetchImpl });

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
      sessionCleanup: { status: "passed", statusCode: 200, acknowledged: true },
    });

    const calls = fetchImpl.mock.calls;
    expect(calls.map(([, init]) => init.method)).toEqual(["POST", "GET", "GET", "GET", "POST"]);
    expect(calls.slice(1).every(([, init]) => init.headers.cookie === "better-auth.session_token=session-secret")).toBe(true);
    expect(new URL(calls[1][0]).searchParams.get("limit")).toBe("1");
    expect(new URL(calls[2][0]).searchParams.get("limit")).toBe("1");
    expect(new URL(calls[4][0]).pathname).toBe("/api/auth/sign-out");

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
      signOutResponse(500),
    ]);

    const result = await runAdminReadCheck(config, { fetchImpl });

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

  it("preserves a primary read failure when sign-out also fails", async () => {
    const fetchImpl = sequenceFetch([
      authResponse(),
      jsonResponse({ error: { message: "private inventory failure" } }, 500),
      signOutResponse(503),
    ]);

    let failure;
    try {
      await runAdminReadCheck(config, { fetchImpl });
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
    expect(getAdminReadCheckConfig([], {
      SCALIUS_ADMIN_READ_EMAIL: "operator@example.test",
      SCALIUS_ADMIN_READ_PASSWORD: "secret",
      SCALIUS_DASHBOARD_BASE_URL: "https://dashboard.example.test",
    })).toMatchObject({
      dashboardBaseUrl: "https://dashboard.example.test",
      email: "operator@example.test",
      password: "secret",
    });
  });
});
