import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { adminToolError } from "./auth";
import {
  ADMIN_READ_ONLY_TOOL_ANNOTATIONS,
  adminApiHeaders,
  compactAdminPagination,
  compactMaskedContact,
  compactString,
  failClosedStatus,
  isRecord,
  parseJsonResponse,
  setCompactNumber,
  setCompactString,
  setCompactTimestamp,
  toolResult,
} from "./shared";
import type { AdminMcpOptions, Env, JsonRecord } from "./types";

const ADMIN_ORDERS_PATH = "/api/v1/admin/orders";

const ADMIN_CUSTOMERS_MCP_SEARCH_PATH = "/api/v1/admin/customers/mcp-search";

const ADMIN_CUSTOMERS_MCP_SEARCH_TARGET = `http://api.internal${ADMIN_CUSTOMERS_MCP_SEARCH_PATH}`;

const ADMIN_ORDER_SEARCH_MAX_ORDERS = 10;

const ADMIN_CUSTOMER_SEARCH_MAX_CUSTOMERS = 10;

const ADMIN_CUSTOMER_SEARCH_MAX_PAGE = 20;

const ADMIN_ORDERS_MAX_STRING_LENGTH = 220;

const ADMIN_CUSTOMERS_MAX_STRING_LENGTH = 220;

const adminOrderSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(80),
  limit: z.number().int().min(1).max(ADMIN_ORDER_SEARCH_MAX_ORDERS).default(5),
  page: z.number().int().min(1).max(20).default(1),
}).strict();

type AdminOrderSearchInput = z.infer<typeof adminOrderSearchInputSchema>;

const adminCustomerSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(ADMIN_CUSTOMER_SEARCH_MAX_CUSTOMERS).default(5),
  page: z.number().int().min(1).max(ADMIN_CUSTOMER_SEARCH_MAX_PAGE).default(1),
}).strict();

type AdminCustomerSearchInput = z.infer<typeof adminCustomerSearchInputSchema>;

function adminOrderToolError(
  code: string,
  query?: JsonRecord,
  status = 503,
): CallToolResult {
  return toolResult({
    adminOrderSearch: {
      source: { path: ADMIN_ORDERS_PATH },
      ...(query ? { query } : {}),
      orders: [],
      pagination: null,
      limits: {
        maxOrders: ADMIN_ORDER_SEARCH_MAX_ORDERS,
        includesTrashed: false,
        includesAddresses: false,
        includesItems: false,
        includesPaymentRecovery: false,
        includesTracking: false,
      },
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin orders are temporarily unavailable.",
    },
  }, true);
}

function adminCustomerSearchLimits(): JsonRecord {
  return {
    maxCustomers: ADMIN_CUSTOMER_SEARCH_MAX_CUSTOMERS,
    maxPage: ADMIN_CUSTOMER_SEARCH_MAX_PAGE,
    includesRawQuery: false,
    includesTrashed: false,
    includesNames: false,
    includesContacts: false,
    includesAddresses: false,
    includesLocation: false,
    includesHistory: false,
    includesOrders: false,
    canMutate: false,
  };
}

function adminCustomerToolError(
  code: string,
  request?: JsonRecord,
  status = 503,
): CallToolResult {
  return toolResult({
    adminCustomerSearch: {
      source: {
        path: ADMIN_CUSTOMERS_MCP_SEARCH_PATH,
        permission: "customers.view",
      },
      ...(request ? { request } : {}),
      customers: [],
      pagination: null,
      limits: adminCustomerSearchLimits(),
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin customers are temporarily unavailable.",
    },
  }, true);
}

function compactAdminCustomer(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = compactString(value.id, ADMIN_CUSTOMERS_MAX_STRING_LENGTH);
  if (!id) return null;

  const customer: JsonRecord = { id };
  setCompactNumber(customer, "totalOrders", value.totalOrders);
  setCompactNumber(customer, "totalSpent", value.totalSpent);
  setCompactTimestamp(customer, "lastOrderAt", value.lastOrderAt);
  setCompactTimestamp(customer, "createdAt", value.createdAt);
  setCompactTimestamp(customer, "updatedAt", value.updatedAt);

  return customer;
}

function compactAdminOrder(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = compactString(value.id, ADMIN_ORDERS_MAX_STRING_LENGTH);
  const orderNumber = compactString(value.orderNumber, ADMIN_ORDERS_MAX_STRING_LENGTH);
  const code = compactString(value.code, ADMIN_ORDERS_MAX_STRING_LENGTH);
  if (!id && !orderNumber && !code) return null;

  const order: JsonRecord = {};
  if (id) order.id = id;
  if (orderNumber) order.orderNumber = orderNumber;
  if (code) order.code = code;

  setCompactTimestamp(order, "createdAt", value.createdAt);
  setCompactTimestamp(order, "updatedAt", value.updatedAt);
  setCompactString(order, "orderStatus", value.orderStatus ?? value.status, ADMIN_ORDERS_MAX_STRING_LENGTH);
  setCompactString(order, "paymentStatus", value.paymentStatus, ADMIN_ORDERS_MAX_STRING_LENGTH);
  setCompactString(order, "fulfillmentStatus", value.fulfillmentStatus, ADMIN_ORDERS_MAX_STRING_LENGTH);
  setCompactString(order, "paymentMethod", value.paymentMethod, ADMIN_ORDERS_MAX_STRING_LENGTH);
  setCompactNumber(order, "totalAmount", value.totalAmount);
  setCompactString(order, "currency", value.currency, 12);
  setCompactNumber(order, "itemCount", value.itemCount);

  const customerEmailMasked = compactMaskedContact(
    value.customerEmailMasked ?? value.maskedCustomerEmail,
  );
  if (customerEmailMasked) order.customerEmailMasked = customerEmailMasked;

  const customerPhoneMasked = compactMaskedContact(
    value.customerPhoneMasked ?? value.maskedCustomerPhone,
  );
  if (customerPhoneMasked) order.customerPhoneMasked = customerPhoneMasked;

  return order;
}

function buildAdminOrderSearchUrl(input: AdminOrderSearchInput): { url: URL; query: JsonRecord } {
  const url = new URL(`http://api.internal${ADMIN_ORDERS_PATH}`);
  const query: JsonRecord = {
    query: input.query,
    page: input.page,
    limit: input.limit,
    sort: "updatedAt",
    order: "desc",
  };

  url.searchParams.set("search", input.query);
  url.searchParams.set("page", String(input.page));
  url.searchParams.set("limit", String(input.limit));
  url.searchParams.set("sort", "updatedAt");
  url.searchParams.set("order", "desc");

  return { url, query };
}

async function fetchAdminOrderSearch(
  env: Env,
  input: AdminOrderSearchInput,
  {
    cookie,
    userAgent,
    signal,
  }: {
    cookie: string;
    userAgent?: string | null;
    signal?: AbortSignal;
  },
): Promise<CallToolResult> {
  const { url, query } = buildAdminOrderSearchUrl(input);
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminOrderToolError("admin_api_unavailable", query);
  }

  try {
    const response = await env.API.fetch(url, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminOrderToolError("admin_order_unavailable", query, response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    if (!body || body.success !== true || !data || !Array.isArray(data.orders)) {
      return adminOrderToolError("admin_order_unavailable", query);
    }

    const pagination = compactAdminPagination(data.pagination);
    if (!pagination) {
      return adminOrderToolError("admin_order_unavailable", query);
    }

    const orders = data.orders
      .map(compactAdminOrder)
      .filter((order): order is JsonRecord => order !== null)
      .slice(0, ADMIN_ORDER_SEARCH_MAX_ORDERS);

    return toolResult({
      adminOrderSearch: {
        source: { path: ADMIN_ORDERS_PATH },
        query,
        orders,
        pagination,
        limits: {
          maxOrders: ADMIN_ORDER_SEARCH_MAX_ORDERS,
          includesTrashed: false,
          includesAddresses: false,
          includesItems: false,
          includesPaymentRecovery: false,
          includesTracking: false,
        },
      },
    });
  } catch {
    return adminOrderToolError("admin_order_unavailable", query);
  }
}

function buildAdminCustomerSearchRequest(input: AdminCustomerSearchInput): {
  body: JsonRecord;
  request: JsonRecord;
} {
  const request: JsonRecord = {
    hasQuery: true,
    page: input.page,
    limit: input.limit,
    sort: "updatedAt",
    order: "desc",
  };

  return {
    body: {
      query: input.query,
      page: input.page,
      limit: input.limit,
    },
    request,
  };
}

async function fetchAdminCustomerSearch(
  env: Env,
  input: AdminCustomerSearchInput,
  {
    cookie,
    userAgent,
    signal,
  }: {
    cookie: string;
    userAgent?: string | null;
    signal?: AbortSignal;
  },
): Promise<CallToolResult> {
  const { body: requestBody, request } = buildAdminCustomerSearchRequest(input);
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminCustomerToolError("admin_api_unavailable", request);
  }

  try {
    const headers = adminApiHeaders(cookie, userAgent);
    headers.set("Content-Type", "application/json");

    const response = await env.API.fetch(ADMIN_CUSTOMERS_MCP_SEARCH_TARGET, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal,
    });
    if (!response.ok) {
      return adminCustomerToolError("admin_customer_unavailable", request, response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    if (!body || body.success !== true || !data || !Array.isArray(data.customers)) {
      return adminCustomerToolError("admin_customer_unavailable", request);
    }

    const pagination = compactAdminPagination(data.pagination);
    if (!pagination) {
      return adminCustomerToolError("admin_customer_unavailable", request);
    }

    const customers = data.customers
      .map(compactAdminCustomer)
      .filter((customer): customer is JsonRecord => customer !== null)
      .slice(0, ADMIN_CUSTOMER_SEARCH_MAX_CUSTOMERS);

    return toolResult({
      adminCustomerSearch: {
        source: {
          path: ADMIN_CUSTOMERS_MCP_SEARCH_PATH,
          permission: "customers.view",
        },
        request,
        customers,
        pagination,
        limits: adminCustomerSearchLimits(),
      },
    });
  } catch {
    return adminCustomerToolError("admin_customer_unavailable", request);
  }
}

export function registerAdminCommerceTools(
  server: McpServer,
  env: Env,
  options: AdminMcpOptions,
): void {
  server.registerTool(
    "admin_order_search",
    {
      title: "Admin Order Search",
      description: "Searches the dashboard order list through API-verified permissions and returns compact order identifiers.",
      inputSchema: adminOrderSearchInputSchema,
      annotations: ADMIN_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input, extra) => {
      const cookie = options.cookie?.trim() ? options.cookie : null;
      if (!cookie) {
        return adminToolError({
          ok: false,
          status: 401,
          code: "admin_session_required",
        });
      }

      return fetchAdminOrderSearch(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );

  server.registerTool(
    "admin_customer_search",
    {
      title: "Admin Customer Search",
      description: "Searches the dashboard customer list through API-verified permissions and returns compact customer metrics.",
      inputSchema: adminCustomerSearchInputSchema,
      annotations: ADMIN_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input, extra) => {
      const cookie = options.cookie?.trim() ? options.cookie : null;
      if (!cookie) {
        return adminToolError({
          ok: false,
          status: 401,
          code: "admin_session_required",
        });
      }

      return fetchAdminCustomerSearch(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );
}
