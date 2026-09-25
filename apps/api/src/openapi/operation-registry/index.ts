// The declarative registry of /api/v1 agent operations. Each domain keeps its
// rows in its own file beside this one (see entry.ts for the row shape and its
// defaults); this file merges them and derives the reviewed policy sets.
import type {
    AgentContinuationOutput,
    AgentOperationBatch,
    AgentOperationExposure,
    AgentOperationHttpMethod,
    AgentOperationMetadata,
    AgentOperationPrincipal,
    AgentOperationRisk,
    AgentOperationSurface,
} from "../agent-operation-manifest";
import { DASHBOARD_ORDER_OPERATIONS } from "./dashboard-orders";
import { DASHBOARD_CATALOG_OPERATIONS } from "./dashboard-catalog";
import { DASHBOARD_BRAND_OPERATIONS } from "./dashboard-brands";
import { DASHBOARD_INVENTORY_OPERATIONS } from "./dashboard-inventory";
import { DASHBOARD_CUSTOMER_OPERATIONS } from "./dashboard-customers";
import { DASHBOARD_CONVERSATION_OPERATIONS } from "./dashboard-conversations";
import { DASHBOARD_MARKETING_OPERATIONS } from "./dashboard-marketing";
import { DASHBOARD_CONTENT_OPERATIONS } from "./dashboard-content";
import { DASHBOARD_HOME_OPERATIONS } from "./dashboard-home";
import { DASHBOARD_SETTINGS_OPERATIONS } from "./dashboard-settings";
import { DASHBOARD_STAFF_OPERATIONS } from "./dashboard-staff";
import { STOREFRONT_ORDER_OPERATIONS } from "./storefront-orders";
import { STOREFRONT_CONVERSATION_OPERATIONS } from "./storefront-conversations";
import { STOREFRONT_CATALOG_OPERATIONS } from "./storefront-catalog";
import { STOREFRONT_BRAND_OPERATIONS } from "./storefront-brands";
import { STOREFRONT_CONTENT_OPERATIONS } from "./storefront-content";
import { STOREFRONT_CUSTOMER_OPERATIONS } from "./storefront-customers";
import { STOREFRONT_AGENT_OPERATIONS } from "./storefront-agent";
import { SYSTEM_OPERATIONS } from "./system";
import { DASHBOARD_CATALOG_PROJECTION_OPERATIONS } from "./dashboard-catalog-projections";
import { DASHBOARD_ATTRIBUTE_TYPED_OPERATIONS } from "./dashboard-attributes-typed";
import { STOREFRONT_ATTRIBUTES_TYPED_OPERATIONS } from "./storefront-attributes-typed";
import type { OperationRegistryEntry } from "./entry";

export type { OperationRegistryEntry } from "./entry";

const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 65_536;

const DEFAULT_PRINCIPALS: Readonly<
  Record<AgentOperationSurface, readonly AgentOperationPrincipal[]>
> = {
  dashboard: ["admin"],
  storefront: ["visitor", "customer"],
  system: ["admin"],
};

/**
 * Every agent operation row, merged from one file per domain and surface.
 * An operation ID belongs to exactly one group (agent-operation-contract.test.ts).
 */
export const OPERATIONS = {
  ...DASHBOARD_ORDER_OPERATIONS,
  ...DASHBOARD_CATALOG_OPERATIONS,
  ...DASHBOARD_BRAND_OPERATIONS,
  ...DASHBOARD_INVENTORY_OPERATIONS,
  ...DASHBOARD_CUSTOMER_OPERATIONS,
  ...DASHBOARD_CONVERSATION_OPERATIONS,
  ...DASHBOARD_MARKETING_OPERATIONS,
  ...DASHBOARD_CONTENT_OPERATIONS,
  ...DASHBOARD_HOME_OPERATIONS,
  ...DASHBOARD_SETTINGS_OPERATIONS,
  ...DASHBOARD_STAFF_OPERATIONS,
  ...STOREFRONT_ORDER_OPERATIONS,
  ...STOREFRONT_CONVERSATION_OPERATIONS,
  ...STOREFRONT_CATALOG_OPERATIONS,
  ...STOREFRONT_BRAND_OPERATIONS,
  ...STOREFRONT_CONTENT_OPERATIONS,
  ...STOREFRONT_CUSTOMER_OPERATIONS,
  ...STOREFRONT_AGENT_OPERATIONS,
  ...SYSTEM_OPERATIONS,
  ...DASHBOARD_CATALOG_PROJECTION_OPERATIONS,
  ...DASHBOARD_ATTRIBUTE_TYPED_OPERATIONS,
  ...STOREFRONT_ATTRIBUTES_TYPED_OPERATIONS,
} satisfies Record<string, OperationRegistryEntry>;

/** The per-domain groups, for the one-group-per-operation check. */
export const OPERATION_GROUPS: readonly Readonly<Record<string, OperationRegistryEntry>>[] = [
  DASHBOARD_ORDER_OPERATIONS,
  DASHBOARD_CATALOG_OPERATIONS,
  DASHBOARD_BRAND_OPERATIONS,
  DASHBOARD_INVENTORY_OPERATIONS,
  DASHBOARD_CUSTOMER_OPERATIONS,
  DASHBOARD_CONVERSATION_OPERATIONS,
  DASHBOARD_MARKETING_OPERATIONS,
  DASHBOARD_CONTENT_OPERATIONS,
  DASHBOARD_HOME_OPERATIONS,
  DASHBOARD_SETTINGS_OPERATIONS,
  DASHBOARD_STAFF_OPERATIONS,
  STOREFRONT_ORDER_OPERATIONS,
  STOREFRONT_CONVERSATION_OPERATIONS,
  STOREFRONT_CATALOG_OPERATIONS,
  STOREFRONT_BRAND_OPERATIONS,
  STOREFRONT_CONTENT_OPERATIONS,
  STOREFRONT_CUSTOMER_OPERATIONS,
  STOREFRONT_AGENT_OPERATIONS,
  SYSTEM_OPERATIONS,
  DASHBOARD_CATALOG_PROJECTION_OPERATIONS,
  DASHBOARD_ATTRIBUTE_TYPED_OPERATIONS,
  STOREFRONT_ATTRIBUTES_TYPED_OPERATIONS,
];

export type OperationId = keyof typeof OPERATIONS;

const REGISTRY: Readonly<Record<string, OperationRegistryEntry>> = OPERATIONS;

export function registryEntry(operationId: string): OperationRegistryEntry | undefined {
  return Object.prototype.hasOwnProperty.call(REGISTRY, operationId)
    ? REGISTRY[operationId]
    : undefined;
}

export function operationSurface(operationId: string): AgentOperationSurface {
  const prefix = operationId.split(".", 1)[0];
  if (prefix === "dashboard" || prefix === "storefront" || prefix === "system") {
    return prefix;
  }
  throw new Error(`${operationId} has no recognised surface prefix.`);
}

/** `GET`/`HEAD` routes read; every other method mutates. */
export function methodRisk(method: string): AgentOperationRisk {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD" ? "read" : "write";
}

/**
 * Expands one registry row into the full `x-scalius-agent` metadata document.
 * Property order is the reviewed contract order and must stay stable: it is
 * serialized into the generated OpenAPI contract bytes.
 */
export function operationMetadata(
  operationId: string,
  method: AgentOperationHttpMethod | string,
  entry: OperationRegistryEntry,
): AgentOperationMetadata {
  const surface = operationSurface(operationId);
  const exposure: AgentOperationExposure = entry.exposure ?? "execute";
  const risk = entry.risk ?? methodRisk(method);
  const batch: AgentOperationBatch =
    entry.batch ??
    (exposure !== "execute" ? "forbidden" : risk === "read" ? "parallel" : "sequential");
  return {
    surface,
    exposure,
    principals: [...(entry.principals ?? DEFAULT_PRINCIPALS[surface])],
    risk,
    openWorld: entry.openWorld ?? false,
    idempotency: entry.idempotency ?? "none",
    revision: entry.revision ?? "none",
    batch,
    transport: entry.transport ?? "json",
    maximumResponseBytes: entry.limits?.response ?? DEFAULT_MAX_RESPONSE_BYTES,
    maxRequestBytes: entry.limits?.request ?? DEFAULT_MAX_REQUEST_BYTES,
    sensitiveOutput: entry.sensitive ?? false,
    oneTimeSecretOutput: entry.oneTimeSecret ?? false,
    ...(entry.clientAction ? { requiredClientAction: entry.clientAction } : {}),
    ...(entry.artifact ? { artifactOutput: entry.artifact } : {}),
    ...(entry.continuation ? { continuationOutput: entry.continuation } : {}),
    ...(exposure === "excluded" && entry.reason ? { exclusionReason: entry.reason } : {}),
  };
}

function operationIdsWhere(
  predicate: (entry: OperationRegistryEntry) => boolean,
): ReadonlySet<string> {
  return new Set(
    Object.entries(REGISTRY)
      .filter(([, entry]) => predicate(entry))
      .map(([operationId]) => operationId),
  );
}

/** Operations reviewed for the device-pairing exposure class. */
export const DEVICE_OPERATION_IDS: ReadonlySet<string> = operationIdsWhere(
  (entry) => entry.exposure === "device",
);

/** Operations reviewed to return a one-time secret exactly once. */
export const ONE_TIME_SECRET_OPERATION_IDS: ReadonlySet<string> =
  operationIdsWhere((entry) => entry.oneTimeSecret === true);

/** Reviewed hosted-continuation output policies, keyed by operation ID. */
export const CONTINUATION_OUTPUTS: Readonly<
  Record<string, AgentContinuationOutput>
> = Object.fromEntries(
  Object.entries(REGISTRY)
    .filter(([, entry]) => entry.continuation !== undefined)
    .map(([operationId, entry]) => [operationId, entry.continuation as AgentContinuationOutput]),
);
