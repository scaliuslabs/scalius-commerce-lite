import { ValidationError } from "../../errors";

export type DeliveryProviderActivationRequirement = {
  source: "credentials" | "config";
  key: string;
  label: string;
};

export type DeliveryProviderActivationBlocker = DeliveryProviderActivationRequirement & {
  message: string;
};

export type DeliveryProviderReadinessStatus = "draft" | "configured" | "tested" | "active" | "blocked";

export type DeliveryProviderReadinessBlocker = {
  code: "inactive" | "unconfigured" | "untested" | "test_failed" | "unreadable";
  message: string;
};

export type DeliveryProviderReadinessSummary = {
  status: DeliveryProviderReadinessStatus;
  configured: boolean;
  tested: boolean;
  active: boolean;
  blockers: DeliveryProviderReadinessBlocker[];
  activationBlockers: DeliveryProviderActivationBlocker[];
  lastTestAttemptAt?: Date | number | string | null;
  lastTestSuccessAt?: Date | number | string | null;
  lastTestFailureAt?: Date | number | string | null;
};

type DeliveryProviderReadinessInput = {
  type: string;
  credentials: Record<string, unknown> | string | null | undefined;
  config: Record<string, unknown> | string | null | undefined;
};

type DeliveryProviderSummaryInput = DeliveryProviderReadinessInput & {
  isActive?: boolean | null;
  currentFingerprint?: string | null;
  lastTestAttemptAt?: Date | number | string | null;
  lastTestSuccessAt?: Date | number | string | null;
  lastTestFailureAt?: Date | number | string | null;
  lastTestSuccessFingerprint?: string | null;
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

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = stableJson((value as Record<string, unknown>)[key]);
      return acc;
    }, {});
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function keyBytes(fingerprintKey: string): ArrayBuffer {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(fingerprintKey), (char) => char.charCodeAt(0));
  } catch {
    bytes = new TextEncoder().encode(fingerprintKey);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function timestampMs(value: Date | number | string | null | undefined): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

export async function getDeliveryProviderSetupFingerprint(
  input: DeliveryProviderReadinessInput,
  fingerprintKey: string,
): Promise<string> {
  const parsedCredentials = toRecord(input.credentials, "credentials");
  const parsedConfig = toRecord(input.config, "config");
  if (isActivationBlocker(parsedCredentials) || isActivationBlocker(parsedConfig)) {
    throw new ValidationError("Delivery provider setup could not be fingerprinted until credentials and config are readable.");
  }

  const material = JSON.stringify(stableJson({
    type: input.type,
    credentials: parsedCredentials,
    config: parsedConfig,
  }));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes(fingerprintKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(material));
  return `hmac-sha256:${bytesToHex(signature)}`;
}

export function getDeliveryProviderReadinessSummary(
  input: DeliveryProviderSummaryInput,
): DeliveryProviderReadinessSummary {
  const activationBlockers = getDeliveryProviderActivationBlockers(input);
  const configured = activationBlockers.length === 0;
  const successAt = timestampMs(input.lastTestSuccessAt);
  const failureAt = timestampMs(input.lastTestFailureAt);
  const successFingerprintMatches = Boolean(
    input.currentFingerprint
      && input.lastTestSuccessFingerprint
      && input.currentFingerprint === input.lastTestSuccessFingerprint,
  );
  const failedAfterSuccess = Boolean(failureAt && (!successAt || failureAt > successAt));
  const tested = configured && successFingerprintMatches && !failedAfterSuccess;
  const active = Boolean(input.isActive) && tested;

  const blockers: DeliveryProviderReadinessBlocker[] = [];
  if (!input.isActive) {
    blockers.push({
      code: "inactive",
      message: "Delivery provider is inactive.",
    });
  }
  if (!configured) {
    blockers.push({
      code: activationBlockers.some((blocker) => blocker.key === "credentials" || blocker.key === "config")
        ? "unreadable"
        : "unconfigured",
      message: "Delivery provider setup is incomplete or unreadable.",
    });
  } else if (!tested) {
    blockers.push({
      code: failedAfterSuccess ? "test_failed" : "untested",
      message: failedAfterSuccess
        ? "Delivery provider connection test failed after the last successful test."
        : "Delivery provider must pass a live connection test for the current setup.",
    });
  }

  let status: DeliveryProviderReadinessStatus;
  if (active) {
    status = "active";
  } else if (input.isActive && blockers.length > 0) {
    status = "blocked";
  } else if (!configured) {
    status = activationBlockers.length > 0 && activationBlockers.some((blocker) => blocker.key === "type")
      ? "blocked"
      : "draft";
  } else if (tested) {
    status = "tested";
  } else {
    status = "configured";
  }

  return {
    status,
    configured,
    tested,
    active,
    blockers,
    activationBlockers,
    lastTestAttemptAt: input.lastTestAttemptAt,
    lastTestSuccessAt: input.lastTestSuccessAt,
    lastTestFailureAt: input.lastTestFailureAt,
  };
}
