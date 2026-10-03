// src/modules/fraud-checker/provider.ts
// The built-in fraud checkers behind the fraud port
// (`@scalius/shared/plugins/providers/fraud`, the one app providers
// implement): a courier-history lookup for a buyer's phone, normalized from
// each provider's own response. The merchant's manual tool on the order
// page; never automatic blocking.
import { formatPhoneForProvider } from "@scalius/shared/customer-utils";
import type { FraudCheck } from "@scalius/shared/plugins/providers";
import type { BoundProvider, BuiltInAdapter } from "../../integrations/provider-port";
import { getFraudCheckProviderDefinition, type FraudCheckProviderType } from "./provider-definitions";

/** A built-in checker's saved settings (one `fraud-checker` row). */
export interface FraudCheckProviderConfig {
  apiUrl: string;
  apiKey: string;
  apiSecret?: string;
  userId?: string;
}

/** The fraud checker a lookup goes through: a built-in one with its row's settings, or an app's. */
export type FraudProvider = BoundProvider<"fraud">;

/** A built-in checker: one provider's API behind the fraud port. */
export type FraudAdapter = BuiltInAdapter<"fraud", FraudCheckProviderConfig>;

// -- Shared normalization ----------------------------------------------------

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

const REQUEST_TIMEOUT_MS = 10_000;

function toLocalPhone(phone: string): string {
  return formatPhoneForProvider(phone);
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

    throw new Error("Provider response did not include fraud status or courier delivery statistics");
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

async function fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function readProviderJson(response: Response): Promise<unknown> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const record = asRecord(data);
    const message =
      (typeof record?.message === "string" && record.message)
      || (typeof record?.error === "string" && record.error)
      || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

/** A provider response as the port's answer. */
function toFraudCheck(raw: unknown, phone: string): FraudCheck {
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

/** The number a connection test looks up. */
const TEST_PHONE = "+8801700000000";

/** One provider's lookup request; everything else is shared. */
function checker(
  id: FraudCheckProviderType,
  request: (phone: string, settings: FraudCheckProviderConfig) => { headers: Record<string, string>; body: BodyInit },
): FraudAdapter {
  return {
    id,
    label: getFraudCheckProviderDefinition(id).label,
    // Bangladesh courier-history services: they know Bangladesh buyers only.
    countries: ["BD"],
    async check({ phone }, { settings, signal }) {
      const response = await fetchWithTimeout(settings.apiUrl, { method: "POST", ...request(phone, settings) }, signal);
      return toFraudCheck(await readProviderJson(response), phone);
    },
    async testConnection(_input, call) {
      try {
        await this.check({ phone: TEST_PHONE }, call);
        return { ok: true, message: "Connection successful" };
      } catch (error: unknown) {
        return { ok: false, message: error instanceof Error ? error.message : "Connection failed" };
      }
    },
  };
}

// -- Default Provider --------------------------------------------------------
// Matches the existing behavior: HTTP POST with phone as FormData,
// Bearer token auth, and a JSON response containing delivery stats.

export const defaultFraudChecker = checker("default", (phone, settings) => {
  const formData = new FormData();
  formData.append("phone", toLocalPhone(phone));
  return { headers: { Authorization: `Bearer ${settings.apiKey}` }, body: formData };
});

export const fraudBdChecker = checker("fraudbd", (phone, settings) => ({
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    api_key: settings.apiKey,
    user_name: settings.userId ?? "",
    password: settings.apiSecret ?? "",
  },
  body: JSON.stringify({ phone_number: toLocalPhone(phone) }),
}));

export const fraudGuardChecker = checker("fraudguard", (phone, settings) => ({
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-API-KEY": settings.apiKey,
    "X-API-SECRET": settings.apiSecret ?? "",
  },
  body: JSON.stringify({ phone_number: toLocalPhone(phone) }),
}));

export const eCourierFraudChecker = checker("ecourier", (phone, settings) => ({
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "API-KEY": settings.apiKey,
    "API-SECRET": settings.apiSecret ?? "",
    "USER-ID": settings.userId ?? "",
  },
  body: JSON.stringify({ number: toLocalPhone(phone) }),
}));

const BUILT_IN_FRAUD_CHECKERS: Readonly<Record<string, FraudAdapter>> = {
  default: defaultFraudChecker,
  fraudbd: fraudBdChecker,
  fraudguard: fraudGuardChecker,
  ecourier: eCourierFraudChecker,
};

/**
 * The built-in checker of a saved provider type; a row without a type is the
 * custom checker. An unknown type is never routed to another checker.
 */
export function builtInFraudChecker(providerType: string | undefined): FraudAdapter {
  const type = providerType || "default";
  if (!Object.hasOwn(BUILT_IN_FRAUD_CHECKERS, type)) {
    throw new Error(`Unsupported fraud checker provider type: ${providerType}`);
  }
  return BUILT_IN_FRAUD_CHECKERS[type]!;
}
