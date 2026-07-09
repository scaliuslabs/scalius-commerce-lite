import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./storefront-runtime";
import {
  ADMIN_COOKIE,
  adminCustomerSearchContext,
  adminOrderSearchContext,
  bootAdmin,
  expectValidationToolError,
  fetchCall,
  json,
  mockJsonFetch,
  parseRequestBody,
  requestUrl,
} from "./runtime-test-support";

describe("admin MCP server — orders and customers", () => {
  it("calls admin_order_search through the API binding with fixed search query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        orders: [{
          id: "order_1",
          orderNumber: "ORD-1001",
          code: "SC-1001",
          customerName: "Asha Rahman",
          customerPhone: "+8801712345678",
          customerEmail: "asha@example.test",
          customerPhoneMasked: "+88017****678",
          customerEmailMasked: "a***@example.test",
          totalAmount: 1250,
          currency: "BDT",
          status: "confirmed",
          paymentStatus: "paid",
          paymentMethod: "sslcommerz",
          fulfillmentStatus: "partial",
          createdAt: "2026-07-07T10:30:00.000Z",
          updatedAt: 1783516200,
          itemCount: 3,
          totalQuantity: 5,
          shippingCharge: 80,
          discountAmount: 50,
          city: "dhaka",
          zone: "mirpur",
          area: "section-10",
          cityName: "Dhaka",
          zoneName: "Mirpur",
          areaName: "Section 10",
          addressLine1: "Road 1",
          notes: "leave at desk",
          receiptToken: "chk_secret",
          paymentRecoveryLink: "https://storefront.example.test/payment-recovery?orderId=order_1",
          paymentRecovery: {
            message: "support message must not leak",
            token: "RECOVERY-TOKEN",
            url: "https://storefront.example.test/payment-recovery?token=secret",
          },
          latestShipment: {
            trackingId: "TRACK-SECRET",
            trackingUrl: "https://carrier.example.test/track/TRACK-SECRET",
          },
          items: [{ sku: "SKU-SECRET", name: "Private line item" }],
          skus: ["SKU-SECRET"],
          providerPayload: { raw: "provider payload secret" },
          supportMessages: ["support message must not leak"],
          unknownSecret: "must-not-leak",
        }],
        pagination: {
          page: 2,
          limit: 3,
          total: 9,
          totalPages: 3,
          rawCursor: "must-not-leak",
        },
      },
      rawMessage: `must-not-leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_order_search",
      arguments: { query: "  ORD-1001  ", limit: 3, page: 2 },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/orders");
    expect([...url.searchParams.entries()]).toEqual([
      ["search", "ORD-1001"],
      ["page", "2"],
      ["limit", "3"],
      ["sort", "updatedAt"],
      ["order", "desc"],
    ]);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    const context = adminOrderSearchContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/orders" },
      query: {
        query: "ORD-1001",
        page: 2,
        limit: 3,
        sort: "updatedAt",
        order: "desc",
      },
      orders: [{
        id: "order_1",
        orderNumber: "ORD-1001",
        code: "SC-1001",
        createdAt: "2026-07-07T10:30:00.000Z",
        updatedAt: 1783516200,
        orderStatus: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "partial",
        paymentMethod: "sslcommerz",
        totalAmount: 1250,
        currency: "BDT",
        itemCount: 3,
        customerEmailMasked: "a***@example.test",
        customerPhoneMasked: "+88017****678",
      }],
      pagination: {
        page: 2,
        limit: 3,
        total: 9,
        totalPages: 3,
      },
      limits: {
        maxOrders: 10,
        includesTrashed: false,
        includesAddresses: false,
        includesItems: false,
        includesPaymentRecovery: false,
        includesTracking: false,
      },
    });
    const orders = context.orders as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(1);
    const order = orders[0];
    if (!order) throw new Error("Expected compact admin order");
    expect(Object.keys(order).sort()).toEqual([
      "code",
      "createdAt",
      "currency",
      "customerEmailMasked",
      "customerPhoneMasked",
      "fulfillmentStatus",
      "id",
      "itemCount",
      "orderNumber",
      "orderStatus",
      "paymentMethod",
      "paymentStatus",
      "totalAmount",
      "updatedAt",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Asha Rahman");
    expect(serialized).not.toContain("+8801712345678");
    expect(serialized).not.toContain("asha@example.test");
    expect(serialized).not.toContain("Road 1");
    expect(serialized).not.toContain("leave at desk");
    expect(serialized).not.toContain("chk_secret");
    expect(serialized).not.toContain("RECOVERY-TOKEN");
    expect(serialized).not.toContain("payment-recovery");
    expect(serialized).not.toContain("TRACK-SECRET");
    expect(serialized).not.toContain("SKU-SECRET");
    expect(serialized).not.toContain("provider payload secret");
    expect(serialized).not.toContain("support message must not leak");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("keeps admin_order_search upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_order_search",
        arguments: { query: "ORD-1001" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminOrderSearch: {
          source: { path: "/api/v1/admin/orders" },
          query: {
            query: "ORD-1001",
            page: 1,
            limit: 5,
            sort: "updatedAt",
            order: "desc",
          },
          orders: [],
          pagination: null,
          limits: {
            maxOrders: 10,
            includesTrashed: false,
            includesAddresses: false,
            includesItems: false,
            includesPaymentRecovery: false,
            includesTracking: false,
          },
        },
        error: {
          code: "admin_order_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("returns a safe admin_order_search tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { orders: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_order_search",
      arguments: { query: "ORD-1001" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unbounded admin_order_search inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { orders: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_order_search",
      arguments: { query: "", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_order_search",
      arguments: { query: "x".repeat(81), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_order_search",
      arguments: { query: "ORD-1001", limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_order_search",
      arguments: { query: "ORD-1001", page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_order_search",
      arguments: {
        query: "ORD-1001",
        status: "paid",
        includeItems: true,
        includeAddresses: true,
        Authorization: "Bearer must-not-forward",
        receiptToken: "chk_secret",
        paymentRecoveryLink: "https://storefront.example.test/payment-recovery?token=secret",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("calls admin_customer_search through the API binding with POST body and compact redacted output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const rawQuery = "Asha +8801712345678 asha@example.test";
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        customers: [{
          id: "cust_1",
          name: "Asha Rahman",
          firstName: "Asha",
          lastName: "Rahman",
          email: "asha@example.test",
          customerEmail: "asha@example.test",
          phone: "+8801712345678",
          customerPhone: "+8801712345678",
          addressLine1: "Road 1",
          city: "Dhaka",
          zone: "Mirpur",
          area: "Section 10",
          location: { lat: 23.8, lng: 90.4 },
          orders: [{ id: "order_secret" }],
          orderIds: ["order_secret"],
          history: [{ action: "signed-in" }],
          totalOrders: 4,
          totalSpent: 1250,
          lastOrderAt: "2026-07-07T10:30:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: 1783516200,
          unknownSecret: "must-not-leak",
        }],
        pagination: {
          page: 2,
          limit: 3,
          total: 9,
          totalPages: 3,
          rawCursor: "must-not-leak",
        },
      },
      rawMessage: `must-not-leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_customer_search",
      arguments: { query: `  ${rawQuery}  `, limit: 3, page: 2 },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(url.href).toBe("http://api.internal/api/v1/admin/customers/mcp-search");
    expect(url.search).toBe("");
    expect(requestUrl(input)).not.toContain("Asha");
    expect(requestUrl(input)).not.toContain("8801712345678");
    expect(requestUrl(input)).not.toContain("asha@example.test");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(parseRequestBody(init)).toEqual({
      query: rawQuery,
      page: 2,
      limit: 3,
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "content-type", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    const context = adminCustomerSearchContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: {
        path: "/api/v1/admin/customers/mcp-search",
        permission: "customers.view",
      },
      request: {
        hasQuery: true,
        page: 2,
        limit: 3,
        sort: "updatedAt",
        order: "desc",
      },
      customers: [{
        id: "cust_1",
        totalOrders: 4,
        totalSpent: 1250,
        lastOrderAt: "2026-07-07T10:30:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: 1783516200,
      }],
      pagination: {
        page: 2,
        limit: 3,
        total: 9,
        totalPages: 3,
      },
      limits: {
        maxCustomers: 10,
        maxPage: 20,
        includesRawQuery: false,
        includesTrashed: false,
        includesNames: false,
        includesContacts: false,
        includesAddresses: false,
        includesLocation: false,
        includesHistory: false,
        includesOrders: false,
        canMutate: false,
      },
    });
    expect(Object.keys(context.request as Record<string, unknown>).sort()).toEqual([
      "hasQuery",
      "limit",
      "order",
      "page",
      "sort",
    ]);
    const customers = context.customers as Array<Record<string, unknown>>;
    expect(customers).toHaveLength(1);
    const customer = customers[0];
    if (!customer) throw new Error("Expected compact admin customer");
    expect(Object.keys(customer).sort()).toEqual([
      "createdAt",
      "id",
      "lastOrderAt",
      "totalOrders",
      "totalSpent",
      "updatedAt",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(rawQuery);
    expect(serialized).not.toContain("Asha Rahman");
    expect(serialized).not.toContain("asha@example.test");
    expect(serialized).not.toContain("+8801712345678");
    expect(serialized).not.toContain("Road 1");
    expect(serialized).not.toContain("Dhaka");
    expect(serialized).not.toContain("Mirpur");
    expect(serialized).not.toContain("Section 10");
    expect(serialized).not.toContain("lat");
    expect(serialized).not.toContain("order_secret");
    expect(serialized).not.toContain("signed-in");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("keeps admin_customer_search upstream failures fail-closed without leaking upstream bodies", async () => {
    const rawQuery = "Asha +8801712345678 asha@example.test";
    const leak = `raw upstream leak ${rawQuery} ${ADMIN_COOKIE} Road 1 Dhaka`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
      () => json({ success: true, data: { customers: [], message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_customer_search",
        arguments: { query: rawQuery },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      const [input] = fetchCall(apiFetch);
      const url = new URL(requestUrl(input));
      expect(url.href).toBe("http://api.internal/api/v1/admin/customers/mcp-search");
      expect(url.search).toBe("");
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminCustomerSearch: {
          source: {
            path: "/api/v1/admin/customers/mcp-search",
            permission: "customers.view",
          },
          request: {
            hasQuery: true,
            page: 1,
            limit: 5,
            sort: "updatedAt",
            order: "desc",
          },
          customers: [],
          pagination: null,
          limits: {
            maxCustomers: 10,
            maxPage: 20,
            includesRawQuery: false,
            includesTrashed: false,
            includesNames: false,
            includesContacts: false,
            includesAddresses: false,
            includesLocation: false,
            includesHistory: false,
            includesOrders: false,
            canMutate: false,
          },
        },
        error: {
          code: "admin_customer_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(rawQuery);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("asha@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("Road 1");
      expect(serialized).not.toContain("Dhaka");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("returns a safe admin_customer_search tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { customers: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_customer_search",
      arguments: { query: "asha@example.test" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(JSON.stringify(result)).not.toContain("asha@example.test");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unbounded admin_customer_search inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { customers: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_customer_search",
      arguments: { query: "", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_customer_search",
      arguments: { query: "   ", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_customer_search",
      arguments: { query: "x".repeat(121), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_customer_search",
      arguments: { query: "asha@example.test", limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_customer_search",
      arguments: { query: "asha@example.test", page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_customer_search",
      arguments: {
        query: "asha@example.test",
        search: "old-field",
        email: "asha@example.test",
        phone: "+8801712345678",
        includeContacts: true,
        includeAddresses: true,
        includeLocation: true,
        includeHistory: true,
        includeOrders: true,
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });
});
