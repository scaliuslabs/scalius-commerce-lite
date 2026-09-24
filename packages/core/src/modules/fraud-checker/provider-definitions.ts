// src/modules/fraud-checker/provider-definitions.ts
// The fraud check providers a merchant can choose, as data: shared by the
// dashboard's settings screen and the server, without the provider clients.

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
