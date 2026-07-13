import type { FraudCheckProviderType } from "@scalius/core/modules/fraud-checker/provider";
import type { ProviderMarkId } from "./settings/provider-marks";

const FRAUD_PROVIDER_MARKS: Partial<Record<FraudCheckProviderType, ProviderMarkId>> = {
  fraudbd: "fraudbd",
  ecourier: "ecourier",
};

export function getFraudProviderMarkId(
  providerType: FraudCheckProviderType | undefined,
): ProviderMarkId | null {
  return providerType ? FRAUD_PROVIDER_MARKS[providerType] ?? null : null;
}
