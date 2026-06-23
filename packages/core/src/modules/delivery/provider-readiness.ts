import { ValidationError } from "../../errors";

export type DeliveryProviderActivationRequirement = {
  source: "credentials" | "config";
  key: string;
  label: string;
};

export type DeliveryProviderActivationBlocker = DeliveryProviderActivationRequirement & {
  message: string;
};

type DeliveryProviderReadinessInput = {
  type: string;
  credentials: Record<string, unknown> | string | null | undefined;
  config: Record<string, unknown> | string | null | undefined;
};

const REQUIRED_ACTIVATION_FIELDS: Record<string, DeliveryProviderActivationRequirement[]> = {
  pathao: [
    { source: "credentials", key: "baseUrl", label: "Base URL" },
    { source: "credentials", key: "clientId", label: "Client ID" },
    { source: "credentials", key: "clientSecret", label: "Client Secret" },
    { source: "credentials", key: "username", label: "Username" },
    { source: "credentials", key: "password", label: "Password" },
    { source: "config", key: "storeId", label: "Store ID" },
  ],
  steadfast: [
    { source: "credentials", key: "baseUrl", label: "Base URL" },
    { source: "credentials", key: "apiKey", label: "API Key" },
    { source: "credentials", key: "secretKey", label: "Secret Key" },
  ],
};

function toRecord(
  value: DeliveryProviderReadinessInput["credentials"],
  source: "credentials" | "config",
): Record<string, unknown> | DeliveryProviderActivationBlocker {
  if (!value) return {};
  if (typeof value !== "string") {
    return typeof value === "object" && !Array.isArray(value)
      ? value
      : {
        source,
        key: source,
        label: source === "credentials" ? "Credentials" : "Configuration",
        message: `${source === "credentials" ? "Credentials" : "Configuration"} must be a JSON object.`,
      };
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {
      source,
      key: source,
      label: source === "credentials" ? "Credentials" : "Configuration",
      message: `${source === "credentials" ? "Credentials" : "Configuration"} must be a valid JSON object.`,
    };
  }
}

function hasUsableValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return value !== null && value !== undefined;
}

function isActivationBlocker(
  value: Record<string, unknown> | DeliveryProviderActivationBlocker,
): value is DeliveryProviderActivationBlocker {
  return typeof (value as DeliveryProviderActivationBlocker).message === "string"
    && ((value as DeliveryProviderActivationBlocker).source === "credentials"
      || (value as DeliveryProviderActivationBlocker).source === "config");
}

export function getDeliveryProviderActivationRequirements(
  type: string,
): DeliveryProviderActivationRequirement[] {
  return REQUIRED_ACTIVATION_FIELDS[type] ?? [];
}

export function getDeliveryProviderActivationBlockers({
  type,
  credentials,
  config,
}: DeliveryProviderReadinessInput): DeliveryProviderActivationBlocker[] {
  const requirements = getDeliveryProviderActivationRequirements(type);
  if (requirements.length === 0) {
    return [{
      source: "config",
      key: "type",
      label: "Provider type",
      message: `Unsupported delivery provider type: ${type}`,
    }];
  }

  const parsedCredentials = toRecord(credentials, "credentials");
  const parsedConfig = toRecord(config, "config");
  const blockers: DeliveryProviderActivationBlocker[] = [];

  if (isActivationBlocker(parsedCredentials)) blockers.push(parsedCredentials);
  if (isActivationBlocker(parsedConfig)) blockers.push(parsedConfig);
  if (blockers.length > 0) return blockers;

  const credentialRecord = parsedCredentials as Record<string, unknown>;
  const configRecord = parsedConfig as Record<string, unknown>;

  for (const requirement of requirements) {
    const sourceRecord = requirement.source === "credentials"
      ? credentialRecord
      : configRecord;
    if (!hasUsableValue(sourceRecord[requirement.key])) {
      blockers.push({
        ...requirement,
        message: `${requirement.label} is required before this provider can be active.`,
      });
    }
  }

  return blockers;
}

export function assertDeliveryProviderReadyForActivation(
  input: DeliveryProviderReadinessInput,
): void {
  const blockers = getDeliveryProviderActivationBlockers(input);
  if (blockers.length === 0) return;

  throw new ValidationError(
    "Delivery provider cannot be activated until required setup is complete.",
    { blockers },
  );
}
