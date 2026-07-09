import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { adminToolError } from "./auth";
import {
  ADMIN_READ_ONLY_TOOL_ANNOTATIONS,
  adminApiHeaders,
  compactBoolean,
  compactNumber,
  compactString,
  failClosedStatus,
  isRecord,
  parseJsonResponse,
  setCompactString,
  toolResult,
} from "./shared";
import type { AdminMcpOptions, Env, JsonRecord } from "./types";

const ADMIN_SETTINGS_SUMMARY_PATH = "/api/v1/admin/settings/mcp-summary";

const ADMIN_SETTINGS_SUMMARY_TARGET = `http://api.internal${ADMIN_SETTINGS_SUMMARY_PATH}`;

const ADMIN_NOTIFICATION_SETTINGS_SUMMARY_PATH = "/api/v1/admin/settings/notification-channels/mcp-summary";

const ADMIN_NOTIFICATION_SETTINGS_SUMMARY_TARGET = `http://api.internal${ADMIN_NOTIFICATION_SETTINGS_SUMMARY_PATH}`;

const ADMIN_NOTIFICATION_SETTINGS_SUMMARY_VERSION = "admin-notification-settings-summary:v1";

const ADMIN_ANALYTICS_HEALTH_PATH = "/api/v1/admin/analytics/health";

const ADMIN_ANALYTICS_HEALTH_TARGET = `http://api.internal${ADMIN_ANALYTICS_HEALTH_PATH}`;

const ADMIN_ANALYTICS_SUMMARY_VERSION = "admin-analytics-summary:v1";

const ADMIN_ANALYTICS_SUMMARY_MAX_PROVIDERS = 12;

const ADMIN_ANALYTICS_MAX_STRING_LENGTH = 160;

const ADMIN_NOTIFICATION_SETTINGS_MAX_STRING_LENGTH = 160;

const ANALYTICS_BROWSER_STATUSES = new Set([
  "ready",
  "draft",
  "blocked",
  "not_configured",
]);

const ANALYTICS_SERVER_STATUSES = new Set([
  "ready",
  "blocked",
  "not_configured",
  "not_applicable",
]);

const adminSettingsSummaryInputSchema = z.object({}).strict();

type AdminSettingsSummaryInput = z.infer<typeof adminSettingsSummaryInputSchema>;

const adminNotificationSettingsSummaryInputSchema = z.object({}).strict();

type AdminNotificationSettingsSummaryInput = z.infer<typeof adminNotificationSettingsSummaryInputSchema>;

const adminAnalyticsSummaryInputSchema = z.object({}).strict();

type AdminAnalyticsSummaryInput = z.infer<typeof adminAnalyticsSummaryInputSchema>;

function adminSettingsSummaryToolError(
  code: string,
  status = 503,
): CallToolResult {
  return toolResult({
    adminSettingsSummary: null,
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin settings summary is temporarily unavailable.",
    },
  }, true);
}

function adminNotificationSettingsSummaryToolError(
  code: string,
  status = 503,
): CallToolResult {
  return toolResult({
    adminNotificationSettingsSummary: null,
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin notification settings summary is temporarily unavailable.",
    },
  }, true);
}

function adminAnalyticsSummaryToolError(
  code: string,
  status = 503,
): CallToolResult {
  return toolResult({
    adminAnalyticsSummary: {
      source: {
        path: ADMIN_ANALYTICS_HEALTH_PATH,
        permission: "analytics.view",
        version: ADMIN_ANALYTICS_SUMMARY_VERSION,
      },
      summary: null,
      providers: [],
      limits: adminAnalyticsSummaryLimits(),
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin analytics summary is temporarily unavailable.",
    },
  }, true);
}

function compactAnalyticsStatus(value: unknown, allowed: Set<string>): string | null {
  const status = compactString(value, 80);
  return status && allowed.has(status) ? status : null;
}

function compactAdminAnalyticsSummaryStats(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const stats: JsonRecord = {};
  for (const key of [
    "totalProviders",
    "browserReadyProviders",
    "draftProviders",
    "blockedProviders",
    "notConfiguredProviders",
    "serverReadyProviders",
  ] as const) {
    const compact = compactNumber(value[key]);
    if (compact === null) return null;
    stats[key] = compact;
  }

  return stats;
}

function compactAdminAnalyticsBrowser(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const status = compactAnalyticsStatus(value.status, ANALYTICS_BROWSER_STATUSES);
  const configured = compactBoolean(value.configured);
  const activeScriptCount = compactNumber(value.activeScriptCount);
  const readyScriptCount = compactNumber(value.readyScriptCount);
  const draftScriptCount = compactNumber(value.draftScriptCount);
  const blockedScriptCount = compactNumber(value.blockedScriptCount);
  if (
    !status ||
    configured === null ||
    activeScriptCount === null ||
    readyScriptCount === null ||
    draftScriptCount === null ||
    blockedScriptCount === null
  ) {
    return null;
  }

  const issueCount = Array.isArray(value.issues) ? value.issues.length : 0;
  return {
    status,
    configured,
    activeScriptCount,
    readyScriptCount,
    draftScriptCount,
    blockedScriptCount,
    issueCount,
  };
}

function compactAdminAnalyticsServerSide(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const status = compactAnalyticsStatus(value.status, ANALYTICS_SERVER_STATUSES);
  const configured = compactBoolean(value.configured);
  if (!status || configured === null) return null;

  const serverSide: JsonRecord = { status, configured };
  setCompactString(serverSide, "label", value.label, ADMIN_ANALYTICS_MAX_STRING_LENGTH);
  return serverSide;
}

function compactAdminAnalyticsProvider(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const provider = compactString(value.provider, ADMIN_ANALYTICS_MAX_STRING_LENGTH);
  const label = compactString(value.label, ADMIN_ANALYTICS_MAX_STRING_LENGTH);
  const browser = compactAdminAnalyticsBrowser(value.browser);
  const serverSide = compactAdminAnalyticsServerSide(value.serverSide);
  if (!provider || !label || !browser || !serverSide) return null;

  return { provider, label, browser, serverSide };
}

function adminAnalyticsSummaryLimits(): JsonRecord {
  return {
    includesScriptConfig: false,
    includesAnalyticsSnippets: false,
    includesCustomCode: false,
    includesProviderIdentifiers: false,
    includesCredentials: false,
    includesRawIssues: false,
    includesProviderMessages: false,
    includesProviderPayloads: false,
    canMutate: false,
  };
}

const ADMIN_NOTIFICATION_CHANNELS = new Set([
  "email",
  "sms",
  "whatsapp",
  "push",
]);

function adminNotificationSettingsSummaryLimitKeys(): readonly string[] {
  return [
    "includesCredentials",
    "includesMaskedSecrets",
    "includesProviderIdentifiers",
    "includesRawProviderErrors",
    "includesRecipients",
    "includesOrderIds",
    "includesDeliveryReceipts",
    "canMutate",
  ];
}

function compactNotificationChannelList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const channels: string[] = [];
  for (const item of value) {
    const channel = compactString(item, 32)?.toLowerCase();
    if (!channel || !ADMIN_NOTIFICATION_CHANNELS.has(channel)) return null;
    if (!channels.includes(channel)) channels.push(channel);
  }
  return channels;
}

function compactAdminNotificationEvent(value: unknown, supportedChannels: readonly string[]): JsonRecord | null {
  if (!isRecord(value)) return null;
  const type = compactString(value.type, ADMIN_NOTIFICATION_SETTINGS_MAX_STRING_LENGTH);
  const label = compactString(value.label, ADMIN_NOTIFICATION_SETTINGS_MAX_STRING_LENGTH);
  const enabledChannels = compactNotificationChannelList(value.enabledChannels);
  const hasAnyChannel = compactBoolean(value.hasAnyChannel);
  if (!type || !label || !enabledChannels || hasAnyChannel === null) return null;
  if (enabledChannels.some((channel) => !supportedChannels.includes(channel))) return null;

  return { type, label, enabledChannels, hasAnyChannel };
}

function compactAdminNotificationEvents(value: unknown, supportedChannels: readonly string[]): JsonRecord[] | null {
  if (!Array.isArray(value)) return null;
  const events = value.map((event) => compactAdminNotificationEvent(event, supportedChannels));
  return events.some((event) => event === null)
    ? null
    : events.filter((event): event is JsonRecord => event !== null);
}

function compactAdminNotificationReadinessEntry(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const configured = compactBoolean(value.configured);
  const ready = compactBoolean(value.ready);
  const issueCount = compactNumber(value.issueCount);
  if (configured === null || ready === null || issueCount === null) return null;

  return { configured, ready, issueCount };
}

function compactAdminNotificationReadinessMap(
  value: unknown,
  supportedChannels: readonly string[],
): JsonRecord | null {
  if (!isRecord(value)) return null;

  const readiness: JsonRecord = {};
  for (const channel of supportedChannels) {
    const entry = compactAdminNotificationReadinessEntry(value[channel]);
    if (!entry) return null;
    readiness[channel] = entry;
  }
  return readiness;
}

function compactAdminNotificationEnabledEventCounts(
  value: unknown,
  supportedChannels: readonly string[],
): JsonRecord | null {
  if (!isRecord(value)) return null;

  const counts: JsonRecord = {};
  for (const channel of supportedChannels) {
    const count = compactNumber(value[channel]);
    if (count === null) return null;
    counts[channel] = count;
  }
  return counts;
}

function compactAdminNotificationSupportedChannels(
  value: unknown,
  expectedChannels: readonly string[],
): string[] | null {
  const channels = compactNotificationChannelList(value);
  if (!channels || channels.length !== expectedChannels.length) return null;
  return expectedChannels.every((channel) => channels.includes(channel)) ? channels : null;
}

function compactAdminNotificationWhatsappTemplate(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const configured = compactBoolean(value.configured);
  const languageConfigured = compactBoolean(value.languageConfigured);
  if (configured === null || languageConfigured === null) return null;
  return { configured, languageConfigured };
}

function compactAdminNotificationAudience(
  value: unknown,
  expectedChannels: readonly string[],
  options: { includeWhatsappTemplate?: boolean } = {},
): JsonRecord | null {
  if (!isRecord(value)) return null;
  const supportedChannels = compactAdminNotificationSupportedChannels(value.supportedChannels, expectedChannels);
  const readiness = compactAdminNotificationReadinessMap(value.readiness, expectedChannels);
  const enabledEventCounts = compactAdminNotificationEnabledEventCounts(value.enabledEventCounts, expectedChannels);
  const events = compactAdminNotificationEvents(value.events, expectedChannels);
  if (!supportedChannels || !readiness || !enabledEventCounts || !events) return null;

  const audience: JsonRecord = {
    supportedChannels,
    readiness,
    enabledEventCounts,
    events,
  };

  if (options.includeWhatsappTemplate) {
    const whatsappTemplate = compactAdminNotificationWhatsappTemplate(value.whatsappTemplate);
    if (!whatsappTemplate) return null;
    audience.whatsappTemplate = whatsappTemplate;
  }

  return audience;
}

function compactAdminNotificationTotals(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const totals: JsonRecord = {};
  for (const key of [
    "orderEventCount",
    "customerEventsWithAnyChannel",
    "merchantEventsWithPush",
    "readinessIssueCount",
  ] as const) {
    const count = compactNumber(value[key]);
    if (count === null) return null;
    totals[key] = count;
  }
  return totals;
}

function compactAdminNotificationSource(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  if (value.path !== ADMIN_NOTIFICATION_SETTINGS_SUMMARY_PATH) return null;
  if (value.permission !== "settings.general.view") return null;
  if (value.version !== ADMIN_NOTIFICATION_SETTINGS_SUMMARY_VERSION) return null;
  return {
    path: ADMIN_NOTIFICATION_SETTINGS_SUMMARY_PATH,
    permission: "settings.general.view",
    version: ADMIN_NOTIFICATION_SETTINGS_SUMMARY_VERSION,
  };
}

function compactAdminNotificationLimits(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const limits: JsonRecord = {};
  for (const key of adminNotificationSettingsSummaryLimitKeys()) {
    if (value[key] !== false) return null;
    limits[key] = false;
  }
  return limits;
}

function compactAdminNotificationSettingsSummary(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const rawSummary = isRecord(value.adminNotificationSettingsSummary)
    ? value.adminNotificationSettingsSummary
    : value;
  const source = compactAdminNotificationSource(rawSummary.source);
  const customer = compactAdminNotificationAudience(rawSummary.customer, ["email", "sms", "whatsapp"], {
    includeWhatsappTemplate: true,
  });
  const merchant = compactAdminNotificationAudience(rawSummary.merchant, ["push"]);
  const totals = compactAdminNotificationTotals(rawSummary.totals);
  const limits = compactAdminNotificationLimits(rawSummary.limits);
  if (!source || !customer || !merchant || !totals || !limits) return null;

  return {
    source,
    customer,
    merchant,
    totals,
    limits,
  };
}

async function fetchAdminSettingsSummary(
  env: Env,
  _input: AdminSettingsSummaryInput,
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
    return adminSettingsSummaryToolError("admin_api_unavailable");
  }

  try {
    const response = await env.API.fetch(ADMIN_SETTINGS_SUMMARY_TARGET, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminSettingsSummaryToolError("admin_settings_summary_unavailable", response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    if (!body || body.success !== true || !data) {
      return adminSettingsSummaryToolError("admin_settings_summary_unavailable");
    }

    return {
      structuredContent: {
        adminSettingsSummary: data,
      },
      content: [{
        type: "text",
        text: "Admin settings summary is available.",
      }],
    };
  } catch {
    return adminSettingsSummaryToolError("admin_settings_summary_unavailable");
  }
}

async function fetchAdminNotificationSettingsSummary(
  env: Env,
  _input: AdminNotificationSettingsSummaryInput,
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
    return adminNotificationSettingsSummaryToolError("admin_api_unavailable");
  }

  try {
    const response = await env.API.fetch(ADMIN_NOTIFICATION_SETTINGS_SUMMARY_TARGET, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminNotificationSettingsSummaryToolError(
        "admin_notification_settings_summary_unavailable",
        response.status,
      );
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    const summary = data ? compactAdminNotificationSettingsSummary(data) : null;
    if (!body || body.success !== true || !summary) {
      return adminNotificationSettingsSummaryToolError("admin_notification_settings_summary_unavailable");
    }

    return {
      structuredContent: {
        adminNotificationSettingsSummary: summary,
      },
      content: [{
        type: "text",
        text: "Admin notification settings summary is available.",
      }],
    };
  } catch {
    return adminNotificationSettingsSummaryToolError("admin_notification_settings_summary_unavailable");
  }
}

async function fetchAdminAnalyticsSummary(
  env: Env,
  _input: AdminAnalyticsSummaryInput,
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
    return adminAnalyticsSummaryToolError("admin_api_unavailable");
  }

  try {
    const response = await env.API.fetch(ADMIN_ANALYTICS_HEALTH_TARGET, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminAnalyticsSummaryToolError("admin_analytics_summary_unavailable", response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    const summary = compactAdminAnalyticsSummaryStats(data?.summary);
    const rawProviders = Array.isArray(data?.providers) ? data.providers : null;
    if (!body || body.success !== true || !data || !summary || !rawProviders) {
      return adminAnalyticsSummaryToolError("admin_analytics_summary_unavailable");
    }

    const compactProviders = rawProviders.map(compactAdminAnalyticsProvider);
    if (compactProviders.some((provider) => provider === null)) {
      return adminAnalyticsSummaryToolError("admin_analytics_summary_unavailable");
    }
    const providers = compactProviders
      .filter((provider): provider is JsonRecord => provider !== null)
      .slice(0, ADMIN_ANALYTICS_SUMMARY_MAX_PROVIDERS);

    return {
      structuredContent: {
        adminAnalyticsSummary: {
          source: {
            path: ADMIN_ANALYTICS_HEALTH_PATH,
            permission: "analytics.view",
            version: ADMIN_ANALYTICS_SUMMARY_VERSION,
          },
          summary,
          providers,
          limits: adminAnalyticsSummaryLimits(),
        },
      },
      content: [{
        type: "text",
        text: "Admin analytics summary is available.",
      }],
    };
  } catch {
    return adminAnalyticsSummaryToolError("admin_analytics_summary_unavailable");
  }
}

export function registerAdminSettingsTools(
  server: McpServer,
  env: Env,
  options: AdminMcpOptions,
): void {
  server.registerTool(
    "admin_settings_summary",
    {
      title: "Admin Settings Summary",
      description: "Reads the redacted dashboard settings summary through API-verified settings permissions.",
      inputSchema: adminSettingsSummaryInputSchema,
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

      return fetchAdminSettingsSummary(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );

  server.registerTool(
    "admin_notification_settings_summary",
    {
      title: "Admin Notification Settings Summary",
      description: "Reads the redacted notification channel settings summary through API-verified settings permissions.",
      inputSchema: adminNotificationSettingsSummaryInputSchema,
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

      return fetchAdminNotificationSettingsSummary(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );

  server.registerTool(
    "admin_analytics_summary",
    {
      title: "Admin Analytics Summary",
      description: "Reads redacted analytics readiness through API-verified analytics permissions.",
      inputSchema: adminAnalyticsSummaryInputSchema,
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

      return fetchAdminAnalyticsSummary(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );
}
