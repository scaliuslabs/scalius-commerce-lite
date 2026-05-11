// src/modules/fraud-checker/provider.ts
// Provider interface and registry for fraud checker integrations.
import { formatPhoneForProvider } from "@scalius/shared/customer-utils";

export const FRAUD_CHECK_PROVIDER_TYPES = [
  "default",
  "fraudbd",
  "fraudguard",
  "ecourier",
] as const;

export type FraudCheckProviderType = (typeof FRAUD_CHECK_PROVIDER_TYPES)[number];

export interface FraudCheckProviderDefinition {
  value: FraudCheckProviderType;
  label: string;
  shortLabel: string;
  defaultApiUrl: string;
  apiKeyLabel: string;
  apiSecretLabel?: string;
  userIdLabel?: string;
  helpText: string;
  docsUrl?: string;
  requestFormatHint: string;
  responseModel: "courier-stats" | "status";
  requiredFields: Array<"apiKey" | "apiSecret" | "userId">;
}

const DEFAULT_FRAUD_CHECK_PROVIDER_DEFINITION: FraudCheckProviderDefinition = {
  value: "default",
  label: "Custom / Legacy API",
  shortLabel: "Custom",
  defaultApiUrl: "https://fraudchecker.link/api/v1/qc/",
  apiKeyLabel: "Bearer Token",
  helpText: "Use an existing custom endpoint that accepts FormData phone and Bearer token auth.",
  requestFormatHint: "POST FormData with phone and Authorization Bearer token.",
  responseModel: "courier-stats",
  requiredFields: ["apiKey"],
};

export const FRAUD_CHECK_PROVIDER_DEFINITIONS: readonly FraudCheckProviderDefinition[] = [
  DEFAULT_FRAUD_CHECK_PROVIDER_DEFINITION,
  {
    value: "fraudbd",
    label: "FraudBD",
    shortLabel: "FraudBD",
    defaultApiUrl: "https://fraudbd.com/api/check-courier-info",
    apiKeyLabel: "API Key",
    apiSecretLabel: "Password",
    userIdLabel: "Username",
    helpText: "Bangladesh courier history API with Pathao, Steadfast, Paperfly, and RedX summaries plus sandbox support.",
    docsUrl: "https://fraudbd.com/api-documentation",
    requestFormatHint: "POST JSON with phone_number and api_key, user_name, password headers.",
    responseModel: "courier-stats",
    requiredFields: ["apiKey", "apiSecret", "userId"],
  },
  {
    value: "fraudguard",
    label: "FraudGuard",
    shortLabel: "FraudGuard",
    defaultApiUrl: "https://fraudguard.slope.com.bd/api/v1/fraud-check",
    apiKeyLabel: "API Key",
    apiSecretLabel: "API Secret",
    helpText: "Bangladesh fraud check API with delivery success rate, customer tag, and courier stats.",
    docsUrl: "https://fraudguard.slope.com.bd/api-documentation",
    requestFormatHint: "POST JSON with phone_number, X-API-KEY, and X-API-SECRET.",
    responseModel: "courier-stats",
    requiredFields: ["apiKey", "apiSecret"],
  },
  {
    value: "ecourier",
    label: "eCourier Fraud Alert",
    shortLabel: "eCourier",
    defaultApiUrl: "https://backoffice.ecourier.com.bd/api/fraud-status-check",
    apiKeyLabel: "API Key",
    apiSecretLabel: "API Secret",
    userIdLabel: "User ID",
    helpText: "Official eCourier merchant fraud alert endpoint returning customer status such as Warning, New Customer, or Verified.",
    docsUrl: "https://ecourier.com.bd/wp-content/uploads/eCourier_Merchant_API_Document_General_v3-7.pdf",
    requestFormatHint: "POST JSON with number, API-KEY, API-SECRET, and USER-ID.",
    responseModel: "status",
    requiredFields: ["apiKey", "apiSecret", "userId"],
  },
];

export function getFraudCheckProviderDefinition(
  providerType: string | undefined,
): FraudCheckProviderDefinition {
  return (
    FRAUD_CHECK_PROVIDER_DEFINITIONS.find((definition) => definition.value === providerType)
    ?? DEFAULT_FRAUD_CHECK_PROVIDER_DEFINITION
  );
}

export function isFraudCheckProviderType(
  providerType: string | undefined,
): providerType is FraudCheckProviderType {
  return FRAUD_CHECK_PROVIDER_DEFINITIONS.some((definition) => definition.value === providerType);
}

export interface FraudCheckProviderConfig {
  apiUrl: string;
  apiKey: string;
  apiSecret?: string;
  userId?: string;
}

/**
 * Normalized result from a fraud check lookup.
 */
export interface FraudCheckResult {
  riskLevel: "low" | "medium" | "high" | "unknown";
  details: Record<string, unknown>;
  raw?: unknown;
}

/**
 * Contract that every fraud-check provider must implement.
 */
export interface FraudCheckProvider {
  readonly name: string;
  /** Check a phone number for fraud signals. */
  lookup(phone: string, config: FraudCheckProviderConfig): Promise<FraudCheckResult>;
}

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

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
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

function toProviderResult(raw: unknown, phone: string): FraudCheckResult {
  const data = normalizeFraudResponse(raw, phone);

  return {
    riskLevel: computeRiskLevel(data),
    details: { ...data },
    raw,
  };
}

// -- Default Provider --------------------------------------------------------
// Matches the existing behavior: HTTP POST with phone as FormData,
// Bearer token auth, and a JSON response containing delivery stats.

export class DefaultFraudCheckProvider implements FraudCheckProvider {
  readonly name = "default";

  async lookup(phone: string, config: FraudCheckProviderConfig): Promise<FraudCheckResult> {
    const formData = new FormData();
    formData.append("phone", toLocalPhone(phone));

    const response = await fetchWithTimeout(config.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: formData,
    });

    return toProviderResult(await readProviderJson(response), phone);
  }
}

export class FraudBdCheckProvider implements FraudCheckProvider {
  readonly name = "fraudbd";

  async lookup(phone: string, config: FraudCheckProviderConfig): Promise<FraudCheckResult> {
    const response = await fetchWithTimeout(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        api_key: config.apiKey,
        user_name: config.userId ?? "",
        password: config.apiSecret ?? "",
      },
      body: JSON.stringify({ phone_number: toLocalPhone(phone) }),
    });

    return toProviderResult(await readProviderJson(response), phone);
  }
}

export class FraudGuardCheckProvider implements FraudCheckProvider {
  readonly name = "fraudguard";

  async lookup(phone: string, config: FraudCheckProviderConfig): Promise<FraudCheckResult> {
    const response = await fetchWithTimeout(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-KEY": config.apiKey,
        "X-API-SECRET": config.apiSecret ?? "",
      },
      body: JSON.stringify({ phone_number: toLocalPhone(phone) }),
    });

    return toProviderResult(await readProviderJson(response), phone);
  }
}

export class ECourierFraudCheckProvider implements FraudCheckProvider {
  readonly name = "ecourier";

  async lookup(phone: string, config: FraudCheckProviderConfig): Promise<FraudCheckResult> {
    const response = await fetchWithTimeout(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "API-KEY": config.apiKey,
        "API-SECRET": config.apiSecret ?? "",
        "USER-ID": config.userId ?? "",
      },
      body: JSON.stringify({ number: toLocalPhone(phone) }),
    });

    return toProviderResult(await readProviderJson(response), phone);
  }
}

// ── Provider Registry ───────────────────────────────────────────────

const providers = new Map<string, FraudCheckProvider>();

// Register the default provider on module load.
providers.set("default", new DefaultFraudCheckProvider());
providers.set("fraudbd", new FraudBdCheckProvider());
providers.set("fraudguard", new FraudGuardCheckProvider());
providers.set("ecourier", new ECourierFraudCheckProvider());

/**
 * Register a custom fraud-check provider.
 */
export function registerFraudCheckProvider(provider: FraudCheckProvider): void {
  providers.set(provider.name, provider);
}

/**
 * Retrieve a provider by type name. Falls back to the default provider
 * when the requested type is not found.
 */
export function getFraudCheckProvider(providerType: string): FraudCheckProvider {
  const provider = providers.get(providerType);
  if (provider) return provider;

  if (!providerType || providerType === "default") {
    return providers.get("default")!;
  }

  throw new Error(`Unsupported fraud checker provider type: ${providerType}`);
}
