import { createServerFn } from "@tanstack/react-start";
import type { FraudCheckProviderType } from "@scalius/core/modules/fraud-checker/provider";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

export interface FraudCheckerProviderPayload {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  apiSecret?: string;
  userId?: string;
  providerType?: FraudCheckProviderType;
  isActive: boolean;
}

export interface SaveFraudCheckerProviderInput {
  name: string;
  apiUrl: string;
  apiKey: string;
  apiSecret?: string;
  userId?: string;
  isActive: boolean;
  providerType?: FraudCheckProviderType;
}

export type UpdateFraudCheckerProviderInput = SaveFraudCheckerProviderInput & {
  id: string;
};

export interface FraudCheckerProviderIdInput {
  id: string;
}

export interface FraudCheckerTestResult {
  success: boolean;
  message?: string;
}

export type RiskLevel = "low" | "medium" | "high" | "unknown";

export interface CourierFraudStats {
  total_parcels: number;
  total_delivered_parcels: number;
  total_cancelled_parcels: number;
}

export interface FraudLookupData {
  mobile_number?: string;
  total_parcels?: number;
  total_delivered?: number;
  total_cancel?: number;
  provider_status?: string;
  message?: string;
  customer_tag?: string;
  success_rate?: number;
  cancel_rate?: number;
  riskLevel?: RiskLevel;
  apis?: Record<string, CourierFraudStats>;
}

export interface FraudLookupInput {
  phone: string;
}

export const getFraudCheckerProviders = createServerFn({
  method: "GET",
}).handler(async () => {
  return apiGet<FraudCheckerProviderPayload[]>("/fraud-checker");
});

export const createFraudCheckerProvider = createServerFn({ method: "POST" })
  .validator((data: SaveFraudCheckerProviderInput) => data)
  .handler(async ({ data }) => {
    return apiPost<FraudCheckerProviderPayload>("/fraud-checker", data);
  });

export const updateFraudCheckerProvider = createServerFn({ method: "POST" })
  .validator((data: UpdateFraudCheckerProviderInput) => data)
  .handler(async ({ data }) => {
    return apiPut<FraudCheckerProviderPayload>("/fraud-checker", data);
  });

export const deleteFraudCheckerProvider = createServerFn({ method: "POST" })
  .validator((data: FraudCheckerProviderIdInput) => data)
  .handler(async ({ data }) => {
    return apiDelete<Record<string, never>>(`/fraud-checker/${data.id}`);
  });

export const testFraudCheckerProvider = createServerFn({ method: "POST" })
  .validator((data: FraudCheckerProviderIdInput) => data)
  .handler(async ({ data }) => {
    return apiPost<FraudCheckerTestResult>(
      `/fraud-checker/${data.id}/test`,
    );
  });

export const fraudCheckerLookup = createServerFn({ method: "POST" })
  .validator((data: FraudLookupInput) => data)
  .handler(async ({ data }) => {
    return apiPost<FraudLookupData>("/fraud-checker/lookup", data);
  });
