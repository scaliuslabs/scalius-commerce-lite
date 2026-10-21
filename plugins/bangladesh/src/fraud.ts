// The Bangladesh courier-history fraud checkers behind the courier-history
// port (`courier_history`): FraudBD, FraudGuard, eCourier Fraud Alert and the
// custom fraudchecker.link API. Moved from core with the same requests and the
// same normalization of each answer into the port's `CourierHistory`. The
// merchant's manual tool on the order page: it advises, it never blocks. They know Bangladesh buyers only
// (`countries: ["BD"]`), so the platform never asks them about anyone else.
//
// Errors are `ProviderError`s with merchant-safe messages: never a credential,
// a provider body or the buyer's phone. Nothing here logs.

import { ProviderError, defineCourierHistoryProvider, type CourierHistory, type CourierHistoryInput, type PluginContext, type ProviderConnection } from "@scalius/plugin-sdk";
import { multipartForm, platformErrorCode, requireText } from "./common";

// ── Normalization (unchanged) ───────────────────────────────────────────

interface NormalizedFraudStats {
  mobile_number: string;
  total_parcels: number;
  total_delivered: number;
  total_cancel: number;
  provider_status?: string;
  message?: string;
  customer_tag?: string;
  success_rate?: number;
  cancel_rate?: number;
  apis?: Record<
    string,
    {
      total_parcels: number;
      total_delivered_parcels: number;
      total_cancelled_parcels: number;
    }
  >;
}

/** E.164 as the services take it: a Bangladesh number in national form (01XXXXXXXXX), else without the plus. */
export function toLocalPhone(phone: string): string {
  return /^\+880\d{10}$/.test(phone) ? `0${phone.slice(4)}` : phone.replace(/^\+/, "");
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/[% ,]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function findNumber(value: unknown, aliases: string[]): number | undefined {
  const aliasSet = new Set(aliases.map(normalizeKey));
  const queue: unknown[] = [value];
  const seen = new Set<object>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const record = asRecord(current);
    if (!record || seen.has(record)) continue;
    seen.add(record);

    for (const [key, entry] of Object.entries(record)) {
      if (aliasSet.has(normalizeKey(key))) {
        const numberValue = asNumber(entry);
        if (numberValue !== undefined) return numberValue;
      }
    }

    queue.push(...Object.values(record));
  }

  return undefined;
}

function findString(value: unknown, aliases: string[]): string | undefined {
  const aliasSet = new Set(aliases.map(normalizeKey));
  const queue: unknown[] = [value];
  const seen = new Set<object>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const record = asRecord(current);
    if (!record || seen.has(record)) continue;
    seen.add(record);

    for (const [key, entry] of Object.entries(record)) {
      if (aliasSet.has(normalizeKey(key)) && typeof entry === "string") {
        return entry;
      }
    }

    queue.push(...Object.values(record));
  }

  return undefined;
}

function findValue(value: unknown, aliases: string[]): unknown {
  const aliasSet = new Set(aliases.map(normalizeKey));
  const queue: unknown[] = [value];
  const seen = new Set<object>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const record = asRecord(current);
    if (!record || seen.has(record)) continue;
    seen.add(record);

    for (const [key, entry] of Object.entries(record)) {
      if (aliasSet.has(normalizeKey(key))) {
        return entry;
      }
    }

    queue.push(...Object.values(record));
  }

  return undefined;
}

function stringifyMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => typeof entry === "string" ? entry : undefined)
      .filter(Boolean)
      .join(", ") || undefined;
  }
  return undefined;
}

function pickPayload(raw: unknown): unknown {
  const record = asRecord(raw);
  if (!record) return raw;

  return (
    record.data
    ?? record.result
    ?? record.response
    ?? record.payload
    ?? raw
  );
}

function normalizeCourierStats(value: unknown): NormalizedFraudStats | null {
  const total =
    findNumber(value, ["total_parcels", "total_parcel", "total_orders", "total_order", "orders", "total_delivery", "total_deliveries", "total"]);
  const delivered =
    findNumber(value, ["total_delivered", "total_delivered_parcels", "delivered_parcels", "successful_delivery", "success_parcel", "success", "delivered"]);
  const cancelled =
    findNumber(value, ["total_cancel", "total_cancelled_parcels", "total_cancelled", "cancelled_parcels", "canceled_delivery", "cancelled_delivery", "cancel_parcel", "cancelled", "canceled", "cancel", "returned"]);

  if (total === undefined && delivered === undefined && cancelled === undefined) {
    return null;
  }

  return {
    mobile_number: findString(value, ["mobile_number", "mobile", "phone", "phone_number", "recipient_mobile"]) ?? "",
    total_parcels: total ?? (delivered ?? 0) + (cancelled ?? 0),
    total_delivered: delivered ?? 0,
    total_cancel: cancelled ?? 0,
    provider_status: findString(value, ["customer_status", "customer_tag", "fraud_status", "risk_level", "riskLevel", "status"]),
    message: stringifyMessage(findValue(value, ["customer_message", "message", "risk_message", "description"])),
    customer_tag: findString(value, ["customer_tag", "customerTag", "data_type"]),
    success_rate: findNumber(value, ["successRate", "success_rate", "delivery_success_rate"]),
    cancel_rate: findNumber(value, ["cancelRate", "cancel_rate"]),
  };
}

function findCourierBreakdown(raw: unknown): NormalizedFraudStats["apis"] | undefined {
  const payload = pickPayload(raw);
  const record = asRecord(payload) ?? asRecord(raw);
  if (!record) return undefined;

  const candidate =
    record.apis
    ?? record.couriers
    ?? record.courier
    ?? record.Summaries
    ?? record.summaries
    ?? record.courier_stats
    ?? record.courierStats
    ?? record.courier_data
    ?? record.courierData
    ?? record.breakdown;

  if (!candidate) return undefined;
  const entries: Array<[string, unknown]> = Array.isArray(candidate)
    ? candidate.map((item, index) => {
        const name =
          findString(item, ["courier", "courier_name", "courierName", "name", "provider"])
          ?? `courier_${index + 1}`;
        return [name, item];
      })
    : Object.entries(candidate as Record<string, unknown>);

  const normalized = entries.reduce<NonNullable<NormalizedFraudStats["apis"]>>((acc, [name, value]) => {
    const stats = normalizeCourierStats(value);
    if (!stats) return acc;

    acc[name] = {
      total_parcels: stats.total_parcels,
      total_delivered_parcels: stats.total_delivered,
      total_cancelled_parcels: stats.total_cancel,
    };
    return acc;
  }, {});

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeStatusResponse(raw: unknown, phone: string): NormalizedFraudStats | null {
  const payload = pickPayload(raw);
  const status = findString(payload, ["customer_status", "customer_tag", "fraud_status", "risk_level", "riskLevel", "status"])
    ?? findString(raw, ["customer_status", "customer_tag", "fraud_status", "risk_level", "riskLevel", "status"]);
  const message = stringifyMessage(findValue(payload, ["customer_message", "message", "risk_message", "description"]))
    ?? stringifyMessage(findValue(raw, ["customer_message", "message", "risk_message", "description"]));

  if (!status && !message) return null;

  return {
    mobile_number: findString(payload, ["mobile_number", "mobile", "phone", "phone_number", "recipient_mobile"]) ?? toLocalPhone(phone),
    total_parcels: 0,
    total_delivered: 0,
    total_cancel: 0,
    provider_status: status,
    message,
    customer_tag: findString(payload, ["customer_tag", "customerTag", "data_type"]),
  };
}

function normalizeFraudResponse(raw: unknown, phone: string): NormalizedFraudStats {
  const payload = pickPayload(raw);
  const stats = normalizeCourierStats(payload) ?? normalizeCourierStats(raw);
  if (!stats) {
    const statusOnly = normalizeStatusResponse(raw, phone);
    if (statusOnly) return statusOnly;

    throw new ProviderError("declined", "The fraud check service answered without a status or courier delivery statistics.", { code: "bangladesh_fraud_unreadable" });
  }

  return {
    ...stats,
    mobile_number: stats.mobile_number || toLocalPhone(phone),
    apis: findCourierBreakdown(raw),
  };
}

function riskFromStatus(status: string | undefined): "low" | "medium" | "high" | "unknown" {
  if (!status) return "unknown";

  const normalized = status.toLowerCase();
  if (
    /\b(warning|fraud|blacklist|blacklisted|blocked|high|risky|bad|danger)\b/.test(normalized)
  ) {
    return "high";
  }
  if (/\b(medium|moderate|suspicious|caution|watch)\b/.test(normalized)) {
    return "medium";
  }
  if (/\b(verified|good|excellent|safe|clear|new customer|low)\b/.test(normalized)) {
    return "low";
  }

  return "unknown";
}

function computeRiskLevel(data: NormalizedFraudStats): "low" | "medium" | "high" | "unknown" {
  const statusRisk = riskFromStatus(data.provider_status ?? data.customer_tag);
  if (statusRisk !== "unknown") return statusRisk;

  const { total_parcels, total_cancel } = data;

  if (total_parcels === 0) return "unknown";

  const cancelRate = total_cancel / total_parcels;

  if (cancelRate >= 0.5) return "high";
  if (cancelRate >= 0.2) return "medium";
  return "low";
}

/** A service answer as the port's answer. */
export function toFraudCheck(raw: unknown, phone: string): CourierHistory {
  const data = normalizeFraudResponse(raw, phone);
  const couriers = data.apis
    ? Object.fromEntries(Object.entries(data.apis).map(([name, stats]) => [name, {
        totalParcels: stats.total_parcels,
        delivered: stats.total_delivered_parcels,
        cancelled: stats.total_cancelled_parcels,
      }]))
    : undefined;

  return {
    riskLevel: computeRiskLevel(data),
    phone: data.mobile_number,
    totalParcels: data.total_parcels,
    delivered: data.total_delivered,
    cancelled: data.total_cancel,
    ...(data.success_rate !== undefined ? { successRate: data.success_rate } : {}),
    ...(data.cancel_rate !== undefined ? { cancelRate: data.cancel_rate } : {}),
    ...(data.customer_tag !== undefined ? { customerTag: data.customer_tag } : {}),
    ...(data.provider_status !== undefined ? { providerStatus: data.provider_status } : {}),
    ...(data.message !== undefined ? { message: data.message } : {}),
    ...(couriers ? { couriers } : {}),
  };
}

const REQUEST_TIMEOUT_MS = 10_000;
/** The number a connection test looks up. */
const TEST_PHONE = "+8801700000000";

const clip = (value: string | undefined, max: number) => (value === undefined ? undefined : value.slice(0, max));

/** The port bounds every text; the services' own words are cut to fit. */
function bounded(check: CourierHistory): CourierHistory {
  const couriers = check.couriers
    ? Object.fromEntries(Object.entries(check.couriers).slice(0, 50).map(([name, stats]) => [name.slice(0, 64), stats]))
    : undefined;
  const nonNegative = (value: number) => Math.max(0, Math.trunc(value));
  const rate = (value: number | undefined) => (value === undefined || !Number.isFinite(value) ? undefined : Math.min(100, Math.max(0, value)));
  const successRate = rate(check.successRate);
  const cancelRate = rate(check.cancelRate);
  const customerTag = clip(check.customerTag, 80);
  const providerStatus = clip(check.providerStatus, 80);
  const message = clip(check.message, 500);
  return {
    riskLevel: check.riskLevel,
    phone: check.phone.slice(0, 20),
    totalParcels: nonNegative(check.totalParcels),
    delivered: nonNegative(check.delivered),
    cancelled: nonNegative(check.cancelled),
    ...(successRate !== undefined ? { successRate } : {}),
    ...(cancelRate !== undefined ? { cancelRate } : {}),
    ...(customerTag !== undefined ? { customerTag } : {}),
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(couriers ? { couriers: Object.fromEntries(Object.entries(couriers).map(([name, stats]) => [name, {
      totalParcels: nonNegative(stats.totalParcels),
      delivered: nonNegative(stats.delivered),
      cancelled: nonNegative(stats.cancelled),
    }])) } : {}),
  };
}

/** One checker: its settings, its address, its request; the call and the answer are shared. */
interface Checker {
  label: string;
  /** The setting that holds the service address, and the hosts it may name (the app's allowed hosts). */
  urlSetting: string;
  hosts: readonly string[];
  request(phone: string, ctx: PluginContext): { headers: Record<string, string>; body: string };
}

function hostAllowed(hostname: string, hosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return hosts.some((pattern) => (pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern));
}

/** The saved service address, or a misconfiguration (https, one of the checker's hosts, no credentials, query or fragment). */
function serviceUrl(checker: Checker, ctx: PluginContext): string {
  const value = requireText(ctx, checker.urlSetting, `${checker.label} API URL`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProviderError("misconfigured", `${checker.label} API URL must be a valid HTTPS address.`, { code: "bangladesh_fraud_url" });
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") || parsed.search || parsed.hash || !hostAllowed(parsed.hostname, checker.hosts)) {
    throw new ProviderError("misconfigured", `${checker.label} API URL must be an HTTPS address on ${checker.hosts.filter((host) => !host.startsWith("*.")).join(" or ")}.`, { code: "bangladesh_fraud_url" });
  }
  return parsed.href;
}

async function lookup(checker: Checker, phone: string, ctx: PluginContext): Promise<CourierHistory> {
  const url = serviceUrl(checker, ctx);
  const request = checker.request(phone, ctx);
  let response;
  try {
    response = await ctx.http.fetch(url, { method: "POST", ...request, timeoutMs: REQUEST_TIMEOUT_MS });
  } catch (error) {
    const code = platformErrorCode(error);
    throw new ProviderError("retryable", code === "http_timeout" ? `${checker.label} did not answer in time.` : `${checker.label} could not be reached.`, {
      code: code === "http_timeout" ? "bangladesh_fraud_timeout" : "bangladesh_fraud_unreachable",
    });
  }
  let data: unknown = {};
  try {
    data = JSON.parse(await response.text());
  } catch {
    data = {};
  }
  if (!response.ok) {
    const misconfigured = response.status === 401 || response.status === 403;
    throw new ProviderError(
      misconfigured ? "misconfigured" : response.status >= 500 || response.status === 429 ? "retryable" : "declined",
      misconfigured ? `${checker.label} refused the saved credentials (HTTP ${response.status}).` : `${checker.label} could not check this number (HTTP ${response.status}).`,
      { code: `bangladesh.fraud_http_${response.status}` },
    );
  }
  return bounded(toFraudCheck(data, phone));
}

function fraudProvider(checker: Checker) {
  return defineCourierHistoryProvider({
    check: (input: CourierHistoryInput, ctx: PluginContext) => lookup(checker, input.phone, ctx),
    async testConnection(_input: Record<string, never>, ctx: PluginContext): Promise<ProviderConnection> {
      try {
        await lookup(checker, TEST_PHONE, ctx);
        return { ok: true, message: "Connection successful" };
      } catch (error) {
        if (error instanceof ProviderError) return { ok: false, message: error.message };
        throw error;
      }
    },
  });
}

const json = { "Content-Type": "application/json", Accept: "application/json" };
const secret = (ctx: PluginContext, key: string, label: string) => requireText(ctx, key, label);

/** The services' hosts, for the manifest's allowed hosts. */
export const FRAUD_CHECKERS: Readonly<Record<"fraudchecker" | "fraudbd" | "fraudguard" | "ecourier", Checker>> = {
  // The custom API: FormData `phone` and a Bearer token (the built-in "Custom / Legacy API").
  fraudchecker: {
    label: "FraudChecker",
    urlSetting: "fraudchecker_api_url",
    hosts: ["fraudchecker.link", "*.fraudchecker.link"],
    request(phone, ctx) {
      const form = multipartForm([["phone", toLocalPhone(phone)]]);
      return { headers: { Authorization: `Bearer ${secret(ctx, "fraudchecker_token", "FraudChecker bearer token")}`, "Content-Type": form.contentType }, body: form.body };
    },
  },
  fraudbd: {
    label: "FraudBD",
    urlSetting: "fraudbd_api_url",
    hosts: ["fraudbd.com", "*.fraudbd.com"],
    request: (phone, ctx) => ({
      headers: {
        ...json,
        api_key: secret(ctx, "fraudbd_api_key", "FraudBD API key"),
        user_name: secret(ctx, "fraudbd_username", "FraudBD username"),
        password: secret(ctx, "fraudbd_password", "FraudBD password"),
      },
      body: JSON.stringify({ phone_number: toLocalPhone(phone) }),
    }),
  },
  fraudguard: {
    label: "FraudGuard",
    urlSetting: "fraudguard_api_url",
    hosts: ["fraudguard.slope.com.bd"],
    request: (phone, ctx) => ({
      headers: {
        ...json,
        "X-API-KEY": secret(ctx, "fraudguard_api_key", "FraudGuard API key"),
        "X-API-SECRET": secret(ctx, "fraudguard_api_secret", "FraudGuard API secret"),
      },
      body: JSON.stringify({ phone_number: toLocalPhone(phone) }),
    }),
  },
  ecourier: {
    label: "eCourier Fraud Alert",
    urlSetting: "ecourier_api_url",
    hosts: ["backoffice.ecourier.com.bd", "*.ecourier.com.bd"],
    request: (phone, ctx) => ({
      headers: {
        ...json,
        "API-KEY": secret(ctx, "ecourier_api_key", "eCourier API key"),
        "API-SECRET": secret(ctx, "ecourier_api_secret", "eCourier API secret"),
        "USER-ID": secret(ctx, "ecourier_user_id", "eCourier user ID"),
      },
      body: JSON.stringify({ number: toLocalPhone(phone) }),
    }),
  },
};

export const fraudProviders = {
  fraudchecker: fraudProvider(FRAUD_CHECKERS.fraudchecker),
  fraudbd: fraudProvider(FRAUD_CHECKERS.fraudbd),
  fraudguard: fraudProvider(FRAUD_CHECKERS.fraudguard),
  ecourier: fraudProvider(FRAUD_CHECKERS.ecourier),
};
