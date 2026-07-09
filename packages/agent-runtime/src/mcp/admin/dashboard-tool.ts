import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { adminToolError } from "./auth";
import {
  ADMIN_READ_ONLY_TOOL_ANNOTATIONS,
  adminApiHeaders,
  compactNumber,
  failClosedStatus,
  isRecord,
  parseJsonResponse,
  toolResult,
} from "./shared";
import type { AdminMcpOptions, Env, JsonRecord } from "./types";

const ADMIN_DASHBOARD_SUMMARY_PATH = "/api/v1/admin/dashboard/metrics-summary";

const ADMIN_DASHBOARD_SUMMARY_TARGET = `http://api.internal${ADMIN_DASHBOARD_SUMMARY_PATH}`;

const adminDashboardSummaryInputSchema = z.object({}).strict();

type AdminDashboardSummaryInput = z.infer<typeof adminDashboardSummaryInputSchema>;

function adminDashboardSummaryToolError(
  code: string,
  status = 503,
): CallToolResult {
  return toolResult({
    adminDashboardSummary: {
      source: {
        path: ADMIN_DASHBOARD_SUMMARY_PATH,
        permission: "dashboard.view",
      },
      stats: null,
      limits: adminDashboardSummaryLimits(),
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin dashboard summary is temporarily unavailable.",
    },
  }, true);
}

function adminDashboardSummaryLimits(): JsonRecord {
  return {
    includesRecentOrders: false,
    includesOrderIds: false,
    includesCustomerPii: false,
    includesCustomerContacts: false,
    includesPaymentEvidence: false,
    includesProviderPayloads: false,
    includesLifetimeRevenue: false,
    includesDailyActivity: false,
    canMutate: false,
  };
}

function compactAdminDashboardOrderStatus(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const delivered = compactNumber(value.delivered);
  const processing = compactNumber(value.processing);
  const shipping = compactNumber(value.shipping);
  const cancelled = compactNumber(value.cancelled);
  if (
    delivered === null ||
    processing === null ||
    shipping === null ||
    cancelled === null
  ) {
    return null;
  }

  return { delivered, processing, shipping, cancelled };
}

function compactAdminDashboardCurrentMonth(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const orders = compactNumber(value.orders);
  const revenue = compactNumber(value.revenue);
  const orderGrowth = compactNumber(value.orderGrowth);
  const revenueGrowth = compactNumber(value.revenueGrowth);
  const orderStatus = compactAdminDashboardOrderStatus(value.orderStatus);
  if (
    orders === null ||
    revenue === null ||
    orderGrowth === null ||
    revenueGrowth === null ||
    !orderStatus
  ) {
    return null;
  }

  return { orders, revenue, orderGrowth, revenueGrowth, orderStatus };
}

function compactAdminDashboardLastMonth(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const orders = compactNumber(value.orders);
  const revenue = compactNumber(value.revenue);
  if (orders === null || revenue === null) return null;

  return { orders, revenue };
}

function compactAdminDashboardStats(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const totalProducts = compactNumber(value.totalProducts);
  const totalCustomers = compactNumber(value.totalCustomers);
  const currentMonth = compactAdminDashboardCurrentMonth(value.currentMonth);
  const lastMonth = compactAdminDashboardLastMonth(value.lastMonth);
  if (
    totalProducts === null ||
    totalCustomers === null ||
    !currentMonth ||
    !lastMonth
  ) {
    return null;
  }

  return { totalProducts, totalCustomers, currentMonth, lastMonth };
}

async function fetchAdminDashboardSummary(
  env: Env,
  _input: AdminDashboardSummaryInput,
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
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminDashboardSummaryToolError("admin_api_unavailable");
  }

  try {
    const response = await env.API.fetch(ADMIN_DASHBOARD_SUMMARY_TARGET, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminDashboardSummaryToolError("admin_dashboard_summary_unavailable", response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    const stats = data ? compactAdminDashboardStats(data.stats) : null;
    if (!body || body.success !== true || !data || !stats) {
      return adminDashboardSummaryToolError("admin_dashboard_summary_unavailable");
    }

    const structuredContent = {
      adminDashboardSummary: {
        source: {
          path: ADMIN_DASHBOARD_SUMMARY_PATH,
          permission: "dashboard.view",
        },
        stats,
        limits: adminDashboardSummaryLimits(),
      },
    };

    return {
      structuredContent,
      content: [{
        type: "text",
        text: "Admin dashboard summary aggregates are available.",
      }],
    };
  } catch {
    return adminDashboardSummaryToolError("admin_dashboard_summary_unavailable");
  }
}

export function registerAdminDashboardTool(
  server: McpServer,
  env: Env,
  options: AdminMcpOptions,
): void {
  server.registerTool(
    "admin_dashboard_summary",
    {
      title: "Admin Dashboard Summary",
      description: "Reads safe aggregate dashboard metrics through API-verified dashboard permissions.",
      inputSchema: adminDashboardSummaryInputSchema,
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

      return fetchAdminDashboardSummary(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );
}
