// src/modules/fraud-checker/provider.ts
// Provider interface and registry for fraud checker integrations.
import { formatPhoneForProvider } from "@scalius/shared/customer-utils";

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
  lookup(phone: string, apiUrl: string, apiKey: string): Promise<FraudCheckResult>;
}

// ── Default Provider ────────────────────────────────────────────────
// Matches the existing behavior: HTTP POST with phone as FormData,
// Bearer token auth, and a JSON response containing delivery stats.

interface DefaultApiResponse {
  mobile_number: string;
  total_parcels: number;
  total_delivered: number;
  total_cancel: number;
  apis?: Record<
    string,
    {
      total_parcels: number;
      total_delivered_parcels: number;
      total_cancelled_parcels: number;
    }
  >;
}

function computeRiskLevel(data: DefaultApiResponse): "low" | "medium" | "high" | "unknown" {
  const { total_parcels, total_cancel } = data;

  if (total_parcels === 0) return "unknown";

  const cancelRate = total_cancel / total_parcels;

  if (cancelRate >= 0.5) return "high";
  if (cancelRate >= 0.2) return "medium";
  return "low";
}

export class DefaultFraudCheckProvider implements FraudCheckProvider {
  readonly name = "default";

  async lookup(phone: string, apiUrl: string, apiKey: string): Promise<FraudCheckResult> {
    const formData = new FormData();
    formData.append("phone", formatPhoneForProvider(phone));

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const message = (errorData as { error?: string }).error || `HTTP ${response.status}`;
      throw new Error(message);
    }

    const data = (await response.json()) as DefaultApiResponse;

    return {
      riskLevel: computeRiskLevel(data),
      details: {
        mobile_number: data.mobile_number,
        total_parcels: data.total_parcels,
        total_delivered: data.total_delivered,
        total_cancel: data.total_cancel,
        apis: data.apis,
      },
      raw: data,
    };
  }
}

// ── Provider Registry ───────────────────────────────────────────────

const providers = new Map<string, FraudCheckProvider>();

// Register the default provider on module load.
providers.set("default", new DefaultFraudCheckProvider());

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
  return providers.get(providerType) ?? providers.get("default")!;
}
