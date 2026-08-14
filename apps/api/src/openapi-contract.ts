import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import {
  AGENT_OPERATION_ID_PATTERN,
  buildAgentOperationManifest,
  type AgentOperationMetadata,
  type AgentOperationRbac,
} from "./openapi/agent-operation-manifest";

type OpenApiSecurityRequirement = Record<string, string[]>;

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  security?: OpenApiSecurityRequirement[];
  responses?: Record<string, unknown>;
  "x-scalius-agent"?: AgentOperationMetadata;
  "x-scalius-rbac"?: AgentOperationRbac;
  [key: string]: unknown;
};

type OpenApiPathItem = Record<string, OpenApiOperation | unknown>;

export type OpenApiDocument = {
  components?: {
    securitySchemes?: Record<string, unknown>;
    [key: string]: unknown;
  };
  paths?: Record<string, OpenApiPathItem | unknown>;
  [key: string]: unknown;
};

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

const SECURITY_SCHEMES = {
  apiTokenHeader: {
    type: "apiKey",
    in: "header",
    name: "X-API-Token",
    description: "Static service token used only to mint short-lived service JWTs through /auth/token.",
  },
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Service JWT returned by /auth/token for protected API-to-API endpoints.",
  },
  adminSession: {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
    description: "Better Auth dashboard session cookie for admin/RBAC protected endpoints.",
  },
  scannerSession: {
    type: "apiKey",
    in: "cookie",
    name: "scanner_sid",
    description: "Limited scanner workflow cookie accepted only by exact inventory scanner endpoints.",
  },
  customerSession: {
    type: "apiKey",
    in: "cookie",
    name: "cs_tok",
    description: "Customer account session cookie for customer account endpoints.",
  },
  agentBearer: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "ScaliusAgentCredential",
    description: "Scoped PAT or CLI credential bound to a live agent grant.",
  },
} as const;

const ERROR_RESPONSE_CONTENT = {
  "application/json": {
    schema: {
      type: "object",
      required: ["success", "error"],
      properties: {
        success: { type: "boolean", enum: [false] },
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            details: {},
          },
        },
      },
    },
  },
} as const;

const CONTRACT_ERROR_RESPONSES = {
  "409": {
    description: "Conflict",
    content: ERROR_RESPONSE_CONTENT,
  },
  "503": {
    description: "Service unavailable",
    content: ERROR_RESPONSE_CONTENT,
  },
} as const;

const SCANNER_SECURITY: OpenApiSecurityRequirement[] = [
  { adminSession: [] },
  { scannerSession: [] },
];

const ADMIN_SECURITY: OpenApiSecurityRequirement[] = [{ adminSession: [] }];
const API_TOKEN_SECURITY: OpenApiSecurityRequirement[] = [{ apiTokenHeader: [] }];
const BEARER_SECURITY: OpenApiSecurityRequirement[] = [{ bearerAuth: [] }];
const CUSTOMER_SECURITY: OpenApiSecurityRequirement[] = [{ customerSession: [] }];
const AGENT_SECURITY: OpenApiSecurityRequirement[] = [{ agentBearer: [] }];
const ADMIN_OR_AGENT_SECURITY: OpenApiSecurityRequirement[] = [
  { adminSession: [] },
  { agentBearer: [] },
];
const SCANNER_ADMIN_OR_AGENT_SECURITY: OpenApiSecurityRequirement[] = [
  { adminSession: [] },
  { scannerSession: [] },
  { agentBearer: [] },
];

function storefrontContextMetadata(
  operationId: string,
  options: Pick<AgentOperationMetadata, "risk" | "revision" | "batch"> &
    Partial<
      Pick<
        AgentOperationMetadata,
        | "exposure"
        | "idempotency"
        | "transport"
        | "maximumResponseBytes"
        | "maxRequestBytes"
        | "sensitiveOutput"
        | "continuationOutput"
        | "exclusionReason"
      >
    >,
): { operationId: string; metadata: AgentOperationMetadata } {
  return {
    operationId,
    metadata: {
      surface: "storefront",
      exposure: options.exposure ?? "execute",
      principals: ["visitor", "customer"],
      risk: options.risk,
      openWorld: false,
      idempotency: options.idempotency ?? "none",
      revision: options.revision,
      batch: options.batch,
      transport: options.transport ?? "json",
      maximumResponseBytes: options.maximumResponseBytes ?? 65_536,
      maxRequestBytes: options.maxRequestBytes ?? 1024 * 1024,
      sensitiveOutput: options.sensitiveOutput ?? false,
      oneTimeSecretOutput: false,
      ...(options.continuationOutput
        ? { continuationOutput: options.continuationOutput }
        : {}),
      ...(options.exposure === "excluded"
        ? { exclusionReason: options.exclusionReason }
        : {}),
    },
  };
}

function deviceOperationMetadata(
  operationId: string,
  options: Pick<AgentOperationMetadata, "idempotency" | "sensitiveOutput">,
): { operationId: string; metadata: AgentOperationMetadata } {
  return {
    operationId,
    metadata: {
      surface: "system",
      exposure: "device",
      principals: ["admin"],
      risk: "security",
      openWorld: false,
      idempotency: options.idempotency,
      revision: "none",
      batch: "forbidden",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 1024 * 1024,
      sensitiveOutput: options.sensitiveOutput,
      oneTimeSecretOutput: false,
    },
  };
}

function agentAccessManagementMetadata(
  operationId: string,
  options: Pick<
    AgentOperationMetadata,
    "risk" | "sensitiveOutput" | "oneTimeSecretOutput"
  >,
): { operationId: string; metadata: AgentOperationMetadata } {
  return {
    operationId,
    metadata: {
      surface: "dashboard",
      exposure: "execute",
      principals: ["admin"],
      risk: options.risk,
      openWorld: false,
      idempotency: "none",
      revision: "none",
      batch: "forbidden",
      transport: "json",
      maximumResponseBytes: options.oneTimeSecretOutput ? 16_384 : 65_536,
      maxRequestBytes: 1024 * 1024,
      sensitiveOutput: options.sensitiveOutput,
      oneTimeSecretOutput: options.oneTimeSecretOutput,
    },
  };
}

function dashboardOperationMetadata(
  operationId: string,
  options: Pick<AgentOperationMetadata, "risk"> &
    Partial<
      Pick<
        AgentOperationMetadata,
        | "exposure"
        | "openWorld"
        | "idempotency"
        | "revision"
        | "batch"
        | "transport"
        | "maximumResponseBytes"
        | "maxRequestBytes"
        | "sensitiveOutput"
        | "oneTimeSecretOutput"
        | "requiredClientAction"
        | "artifactOutput"
        | "continuationOutput"
        | "exclusionReason"
      >
    >,
): { operationId: string; metadata: AgentOperationMetadata } {
  const exposure = options.exposure ?? "execute";
  return {
    operationId,
    metadata: {
      surface: "dashboard",
      exposure,
      principals: ["admin"],
      risk: options.risk,
      openWorld: options.openWorld ?? false,
      idempotency: options.idempotency ?? "none",
      revision: options.revision ?? "none",
      batch: options.batch ?? (exposure === "excluded"
        ? "forbidden"
        : options.risk === "read"
          ? "parallel"
          : "sequential"),
      transport: options.transport ?? "json",
      maximumResponseBytes: options.maximumResponseBytes ?? 65_536,
      maxRequestBytes: options.maxRequestBytes ?? 1024 * 1024,
      sensitiveOutput: options.sensitiveOutput ?? false,
      oneTimeSecretOutput: options.oneTimeSecretOutput ?? false,
      ...(options.requiredClientAction
        ? { requiredClientAction: options.requiredClientAction }
        : {}),
      ...(options.artifactOutput ? { artifactOutput: options.artifactOutput } : {}),
      ...(options.continuationOutput
        ? { continuationOutput: options.continuationOutput }
        : {}),
      ...(exposure === "excluded"
        ? {
            exclusionReason:
              options.exclusionReason ??
              "Pending operation-specific parity, authority, and output review.",
          }
        : {}),
    },
  };
}

function storefrontReadMetadata(
  operationId: string,
  maximumResponseBytes = 65_536,
  maxRequestBytes = 1024 * 1024,
): { operationId: string; metadata: AgentOperationMetadata } {
  return {
    operationId,
    metadata: {
      surface: "storefront",
      exposure: "execute",
      principals: ["visitor", "customer"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      revision: "none",
      batch: "parallel",
      transport: "json",
      maximumResponseBytes,
      maxRequestBytes,
      sensitiveOutput: false,
      oneTimeSecretOutput: false,
    },
  };
}

type ReviewedExclusionOptions = Pick<
  AgentOperationMetadata,
  "surface" | "risk" | "openWorld" | "idempotency" | "transport" | "sensitiveOutput"
> & {
  principals: readonly AgentOperationMetadata["principals"][number][];
  exclusionReason: string;
  maximumResponseBytes?: number;
  maxRequestBytes?: number;
};

function reviewedExclusionMetadata(
  operationId: string,
  options: ReviewedExclusionOptions,
): { operationId: string; metadata: AgentOperationMetadata } {
  return {
    operationId,
    metadata: {
      surface: options.surface,
      exposure: "excluded",
      principals: [...options.principals],
      risk: options.risk,
      openWorld: options.openWorld,
      idempotency: options.idempotency,
      revision: "none",
      batch: "forbidden",
      transport: options.transport,
      maximumResponseBytes: options.maximumResponseBytes ?? 65_536,
      maxRequestBytes: options.maxRequestBytes ?? 1024 * 1024,
      sensitiveOutput: options.sensitiveOutput,
      oneTimeSecretOutput: false,
      exclusionReason: options.exclusionReason,
    },
  };
}

function reviewedEntries(
  operationIds: readonly string[],
  build: (operationId: string) => { operationId: string; metadata: AgentOperationMetadata },
): Record<string, { operationId: string; metadata: AgentOperationMetadata }> {
  return Object.fromEntries(operationIds.map((operationId) => [operationId, build(operationId)]));
}

type DashboardOperationTuple = readonly [
  operationId: string,
  risk: AgentOperationMetadata["risk"],
  openWorld: boolean,
  idempotency: AgentOperationMetadata["idempotency"],
  revision: AgentOperationMetadata["revision"],
  batch: AgentOperationMetadata["batch"],
  transport?: AgentOperationMetadata["transport"],
];

function dashboardTupleEntries(
  tuples: readonly DashboardOperationTuple[],
): Record<string, { operationId: string; metadata: AgentOperationMetadata }> {
  return Object.fromEntries(tuples.map(([
    operationId,
    risk,
    openWorld,
    idempotency,
    revision,
    batch,
    transport = "json",
  ]) => [
    operationId,
    dashboardOperationMetadata(operationId, {
      risk,
      openWorld,
      idempotency,
      revision,
      batch,
      transport,
    }),
  ]));
}

const REVIEWED_AGENT_OPERATIONS: Readonly<
  Record<
    string,
    {
      operationId: string;
      metadata: AgentOperationMetadata;
    }
  >
> = {
  "POST /admin/settings/abandoned-checkouts": reviewedExclusionMetadata(
    "dashboard.settings_abandoned_checkouts.abandoned_checkouts",
    {
      surface: "dashboard",
      principals: ["admin"],
      risk: "write",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 8_192,
      sensitiveOutput: false,
      exclusionReason:
        "Legacy dashboard-prefix mount of storefront abandoned-checkout snapshot persistence; no merchant UI invokes it, and agents must use protected context and cart operations rather than manufacture browser recovery snapshots.",
    },
  ),
  "POST /admin/settings/abandoned-checkouts/cleanup": reviewedExclusionMetadata(
    "dashboard.settings_abandoned_checkouts_cleanup.cleanup",
    {
      surface: "dashboard",
      principals: ["admin"],
      risk: "destructive",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 8_192,
      sensitiveOutput: false,
      exclusionReason:
        "Legacy dashboard-prefix mount of the service-authenticated post-order housekeeping callback; use explicit merchant deletion or scheduled retention cleanup.",
    },
  ),
  "POST /storefront/theme-preview/resolve": {
    operationId: "system.storefront_theme_preview.resolve",
    metadata: {
      surface: "system",
      exposure: "excluded",
      principals: ["internal"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      revision: "none",
      batch: "forbidden",
      transport: "json",
      maximumResponseBytes: 65_536,
      maxRequestBytes: 16_384,
      sensitiveOutput: false,
      oneTimeSecretOutput: false,
      exclusionReason:
        "Private storefront cookie-bearer resolver; the preview token must never enter agent input or execution.",
    },
  },
  "POST /storefront/agent-continuations/theme-preview": {
    operationId: "system.storefront_continuations.theme_preview_exchange",
    metadata: {
      surface: "system",
      exposure: "excluded",
      principals: ["internal"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      revision: "none",
      batch: "forbidden",
      transport: "json",
      maximumResponseBytes: 8_192,
      maxRequestBytes: 65_536,
      sensitiveOutput: true,
      oneTimeSecretOutput: false,
      exclusionReason:
        "Service-authenticated server-only theme preview bearer exchange.",
    },
  },
  "POST /storefront/agent-continuations/bootstrap": {
    operationId: "system.storefront_continuations.bootstrap_claim",
    metadata: {
      surface: "system",
      exposure: "excluded",
      principals: ["internal"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      revision: "none",
      batch: "forbidden",
      transport: "json",
      maximumResponseBytes: 8_192,
      maxRequestBytes: 1_024,
      sensitiveOutput: false,
      oneTimeSecretOutput: false,
      exclusionReason:
        "Service-authenticated storefront bridge that consumes a one-time browser bootstrap code and returns only its non-bearer continuation locator.",
    },
  },
  "GET /agent-artifacts/{artifactId}": {
    operationId: "system.agent_artifacts.download",
    metadata: {
      surface: "system",
      exposure: "excluded",
      principals: ["admin", "visitor", "customer"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      revision: "none",
      batch: "forbidden",
      transport: "json",
      maximumResponseBytes: 65_536,
      maxRequestBytes: 16_384,
      sensitiveOutput: false,
      oneTimeSecretOutput: false,
      artifactOutput: {
        mediaTypes: [
          "application/json",
          "application/pdf",
          "application/zip",
          "image/jpeg",
          "image/png",
          "image/svg+xml",
          "image/webp",
          "text/csv",
          "text/html",
          "text/plain",
        ],
        disposition: "attachment",
        filenamePolicy: "content-disposition",
        maxArtifactBytes: 16 * 1024 * 1024,
        delivery: "direct-stream",
      },
      exclusionReason: "Dedicated authenticated one-use artifact transfer; not an operations.execute capability.",
    },
  },
  "POST /agent-auth/device/start": deviceOperationMetadata(
    "system.agent_auth.device_start",
    { idempotency: "none", sensitiveOutput: true },
  ),
  "POST /agent-auth/device/token": deviceOperationMetadata(
    "system.agent_auth.device_token",
    { idempotency: "none", sensitiveOutput: true },
  ),
  "POST /agent-auth/device/ack": deviceOperationMetadata(
    "system.agent_auth.device_ack",
    { idempotency: "supported", sensitiveOutput: false },
  ),
  "POST /agent-auth/revoke": {
    operationId: "system.agent_auth.revoke",
    metadata: {
      surface: "system",
      exposure: "device",
      principals: ["admin"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      revision: "none",
      batch: "forbidden",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 1024 * 1024,
      sensitiveOutput: false,
      oneTimeSecretOutput: false,
    },
  },
  "GET /admin/agent-access/connections": agentAccessManagementMetadata(
    "dashboard.agent_access.connections.list",
    { risk: "read", sensitiveOutput: false, oneTimeSecretOutput: false },
  ),
  "GET /admin/agent-access/connections/{grantId}": agentAccessManagementMetadata(
    "dashboard.agent_access.connections.get",
    { risk: "read", sensitiveOutput: false, oneTimeSecretOutput: false },
  ),
  "GET /admin/agent-access/connections/{grantId}/events": agentAccessManagementMetadata(
    "dashboard.agent_access.connections.events_list",
    { risk: "read", sensitiveOutput: false, oneTimeSecretOutput: false },
  ),
  "GET /admin/agent-access/browser-handoffs/{handoffId}": reviewedExclusionMetadata(
    "dashboard.agent_access.browser_handoff.open",
    {
      surface: "dashboard",
      principals: ["admin"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 16_384,
      sensitiveOutput: false,
      exclusionReason:
        "Browser-only handoff page bound to the same 2FA-verified administrator; agents receive only its non-secret resource link.",
    },
  ),
  "POST /admin/agent-access/browser-handoffs/{handoffId}": reviewedExclusionMetadata(
    "dashboard.agent_access.browser_handoff.claim",
    {
      surface: "dashboard",
      principals: ["admin"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 8_192,
      maxRequestBytes: 16_384,
      sensitiveOutput: true,
      exclusionReason:
        "Browser-only one-use claim returns sensitive continuation fields solely inside the authenticated browser session.",
    },
  ),
  "POST /admin/agent-access/tokens": agentAccessManagementMetadata(
    "dashboard.agent_access.tokens.create",
    { risk: "security", sensitiveOutput: true, oneTimeSecretOutput: true },
  ),
  "POST /admin/agent-access/tokens/{credentialId}/rotate": agentAccessManagementMetadata(
    "dashboard.agent_access.tokens.rotate",
    { risk: "security", sensitiveOutput: true, oneTimeSecretOutput: true },
  ),
  "PATCH /admin/agent-access/grants/{grantId}": agentAccessManagementMetadata(
    "dashboard.agent_access.grants.update",
    { risk: "security", sensitiveOutput: false, oneTimeSecretOutput: false },
  ),
  "DELETE /admin/agent-access/grants/{grantId}": agentAccessManagementMetadata(
    "dashboard.agent_access.grants.revoke",
    { risk: "security", sensitiveOutput: false, oneTimeSecretOutput: false },
  ),
  "GET /admin/products": {
    operationId: "dashboard.products.list",
    metadata: {
      surface: "dashboard",
      exposure: "excluded",
      principals: ["admin"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      revision: "none",
      batch: "forbidden",
      transport: "json",
      maximumResponseBytes: 65_536,
      maxRequestBytes: 1024 * 1024,
      sensitiveOutput: false,
      oneTimeSecretOutput: false,
      exclusionReason:
        "Legacy dashboard list may include oversized rich text and media projections; use dashboard.products.list_summaries.",
    },
  },
  "POST /admin/products": {
    operationId: "dashboard.products.create",
    metadata: {
      surface: "dashboard",
      exposure: "execute",
      principals: ["admin"],
      risk: "write",
      openWorld: false,
      idempotency: "none",
      revision: "none",
      batch: "sequential",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 1024 * 1024,
      sensitiveOutput: false,
      oneTimeSecretOutput: false,
    },
  },
  "GET /products": {
    operationId: "storefront.products.list",
    metadata: {
      surface: "storefront",
      exposure: "execute",
      principals: ["visitor", "customer"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      revision: "none",
      batch: "parallel",
      transport: "json",
      maximumResponseBytes: 65_536,
      maxRequestBytes: 16_384,
      sensitiveOutput: false,
      oneTimeSecretOutput: false,
    },
  },
  "POST /storefront/agent-contexts": storefrontContextMetadata(
    "storefront.context.create",
    { risk: "write", revision: "none", batch: "sequential" },
  ),
  "GET /storefront/agent-contexts/{contextId}": storefrontContextMetadata(
    "storefront.context.get",
    { risk: "read", revision: "none", batch: "parallel" },
  ),
  "POST /storefront/agent-contexts/{contextId}/close": storefrontContextMetadata(
    "storefront.context.close",
    { risk: "write", revision: "required", batch: "sequential" },
  ),
  "GET /storefront/agent-contexts/{contextId}/cart": storefrontContextMetadata(
    "storefront.cart.get",
    { risk: "read", revision: "none", batch: "parallel" },
  ),
  "POST /storefront/agent-contexts/{contextId}/cart/items": storefrontContextMetadata(
    "storefront.cart.add",
    { risk: "write", revision: "required", batch: "sequential" },
  ),
  "PATCH /storefront/agent-contexts/{contextId}/cart/items": storefrontContextMetadata(
    "storefront.cart.set_quantity",
    { risk: "write", revision: "required", batch: "sequential" },
  ),
  "DELETE /storefront/agent-contexts/{contextId}/cart/items": storefrontContextMetadata(
    "storefront.cart.remove",
    { risk: "write", revision: "required", batch: "sequential" },
  ),
  "DELETE /storefront/agent-contexts/{contextId}/cart": storefrontContextMetadata(
    "storefront.cart.clear",
    { risk: "write", revision: "required", batch: "sequential" },
  ),
  "PUT /storefront/agent-contexts/{contextId}/discount": storefrontContextMetadata(
    "storefront.discount.apply",
    { risk: "write", revision: "required", batch: "sequential" },
  ),
  "DELETE /storefront/agent-contexts/{contextId}/discount": storefrontContextMetadata(
    "storefront.discount.remove",
    { risk: "write", revision: "required", batch: "sequential" },
  ),
  "PUT /storefront/agent-contexts/{contextId}/delivery": storefrontContextMetadata(
    "storefront.delivery.set",
    { risk: "write", revision: "required", batch: "sequential" },
  ),
  "POST /storefront/agent-contexts/{contextId}/checkout/validate": storefrontContextMetadata(
    "storefront.checkout.validate",
    { risk: "read", revision: "none", batch: "parallel" },
  ),
  "POST /storefront/agent-contexts/{contextId}/checkout/quote": storefrontContextMetadata(
    "storefront.checkout.quote",
    { risk: "read", revision: "none", batch: "parallel" },
  ),
  "POST /storefront/agent-contexts/{contextId}/checkout/submit": storefrontContextMetadata(
    "storefront.checkout.submit",
    {
      risk: "financial",
      idempotency: "required",
      revision: "required",
      batch: "sequential",
      maximumResponseBytes: 16_384,
    },
  ),
  "POST /storefront/agent-contexts/{contextId}/customer/auth": storefrontContextMetadata(
    "storefront.customer_auth.begin",
    {
      risk: "security",
      exposure: "continuation",
      revision: "none",
      batch: "forbidden",
      transport: "continuation",
      maximumResponseBytes: 8_192,
      maxRequestBytes: 16_384,
      sensitiveOutput: true,
      continuationOutput: {
        method: "POST",
        urlJsonPointer: "/data/browser/url",
        fieldsJsonPointer: "/data/browser/fields",
        sensitiveFields: ["continuationCode"],
      },
    },
  ),
  "GET /storefront/agent-contexts/{contextId}/customer/auth/{continuationId}": storefrontContextMetadata(
    "storefront.customer_auth.status",
    {
      exposure: "continuation",
      risk: "read",
      revision: "none",
      batch: "forbidden",
    },
  ),
  "POST /storefront/agent-contexts/{contextId}/customer/logout": storefrontContextMetadata(
    "storefront.customer_auth.logout",
    { risk: "security", revision: "required", batch: "sequential" },
  ),
  "GET /storefront/agent-contexts/{contextId}/customer/profile": storefrontContextMetadata(
    "storefront.customer_profile.get",
    { risk: "read", revision: "none", batch: "parallel" },
  ),
  "PUT /storefront/agent-contexts/{contextId}/customer/profile": storefrontContextMetadata(
    "storefront.customer_profile.update",
    { risk: "write", revision: "none", batch: "sequential" },
  ),
  "GET /storefront/agent-contexts/{contextId}/customer/orders": storefrontContextMetadata(
    "storefront.orders.list",
    { risk: "read", revision: "none", batch: "parallel" },
  ),
  "GET /storefront/agent-contexts/{contextId}/customer/orders/{orderId}": storefrontContextMetadata(
    "storefront.orders.get",
    { risk: "read", revision: "none", batch: "parallel" },
  ),
  "GET /storefront/agent-contexts/{contextId}/orders/{orderId}/receipt": storefrontContextMetadata(
    "storefront.receipt.get",
    { risk: "read", revision: "none", batch: "parallel" },
  ),
  "POST /storefront/agent-contexts/{contextId}/orders/{orderId}/support-requests": storefrontContextMetadata(
    "storefront.orders.support_request.create",
    { risk: "write", revision: "none", batch: "sequential" },
  ),
  "POST /storefront/agent-contexts/{contextId}/orders/{orderId}/payment": storefrontContextMetadata(
    "storefront.orders.payment.begin",
    {
      risk: "financial",
      exposure: "continuation",
      revision: "none",
      batch: "forbidden",
      transport: "continuation",
      maximumResponseBytes: 8_192,
      maxRequestBytes: 16_384,
      sensitiveOutput: true,
      continuationOutput: {
        method: "POST",
        urlJsonPointer: "/data/browser/url",
        fieldsJsonPointer: "/data/browser/fields",
        sensitiveFields: ["continuationCode"],
      },
    },
  ),
  "GET /storefront/agent-contexts/{contextId}/payments/{continuationId}": storefrontContextMetadata(
    "storefront.payment.status",
    {
      exposure: "continuation",
      risk: "read",
      revision: "none",
      batch: "forbidden",
    },
  ),
  "POST /storefront/agent-contexts/{contextId}/orders/{orderId}/payment-recovery": storefrontContextMetadata(
    "storefront.payment_recovery.begin",
    {
      risk: "security",
      exposure: "continuation",
      revision: "none",
      batch: "forbidden",
      transport: "continuation",
      maximumResponseBytes: 8_192,
      maxRequestBytes: 16_384,
      sensitiveOutput: true,
      continuationOutput: {
        method: "POST",
        urlJsonPointer: "/data/browser/url",
        fieldsJsonPointer: "/data/browser/fields",
        sensitiveFields: ["continuationCode"],
      },
    },
  ),
  "GET /storefront/agent-contexts/{contextId}/payment-recoveries/{continuationId}": storefrontContextMetadata(
    "storefront.payment_recovery.status",
    {
      exposure: "continuation",
      risk: "read",
      revision: "none",
      batch: "forbidden",
    },
  ),
  "GET /storefront/agent-contexts/{contextId}/continuations/{continuationId}": {
    operationId: "storefront.continuations.get",
    metadata: {
      ...storefrontContextMetadata(
        "storefront.continuations.get",
        { risk: "read", revision: "none", batch: "forbidden" },
      ).metadata,
      exposure: "continuation",
    },
  },
};

const CATALOG_READ_OPERATION_IDS = [
  "dashboard.products.stats",
  "dashboard.products.lookup_barcode",
  "dashboard.products.list",
  "dashboard.products.list_summaries",
  "dashboard.products.get_by_ids",
  "dashboard.products.get_section",
  "dashboard.product_variants.list",
  "dashboard.categories.form_options",
  "dashboard.categories.list",
  "dashboard.categories.list_summaries",
  "dashboard.categories.publish_readiness",
  "dashboard.categories.get",
  "dashboard.categories.get_section",
  "dashboard.attributes.list",
  "dashboard.attributes.list_summaries",
  "dashboard.attribute_values.list",
  "dashboard.collections.form_options",
  "dashboard.collections.category_options",
  "dashboard.collections.product_options",
  "dashboard.collections.list",
  "dashboard.collections.get_by_ids",
  "dashboard.collections.get",
  "dashboard.collections.get_section",
  "dashboard.inventory.list",
  "dashboard.inventory_alerts.list",
  "dashboard.inventory_labels.preview",
  "dashboard.inventory.lookup_sku",
] as const;

const CATALOG_WRITE_OPERATION_IDS = [
  "dashboard.products.create",
  "dashboard.products.update_section",
  "dashboard.products.update",
  "dashboard.products.restore",
  "dashboard.product_variants.create",
  "dashboard.product_variants.update",
  "dashboard.product_options.save_matrix",
  "dashboard.categories.create",
  "dashboard.categories.bulk_restore",
  "dashboard.categories.update",
  "dashboard.categories.set_status",
  "dashboard.categories.restore",
  "dashboard.attributes.create",
  "dashboard.attributes.update",
  "dashboard.attributes.bulk_restore",
  "dashboard.attributes.restore",
  "dashboard.attribute_values.create",
  "dashboard.attribute_values.rename",
  "dashboard.collections.create",
  "dashboard.collections.bulk_activate",
  "dashboard.collections.bulk_deactivate",
  "dashboard.collections.bulk_restore",
  "dashboard.collections.restore",
  "dashboard.collections.reorder",
  "dashboard.collections.update",
  "dashboard.inventory_alerts.acknowledge",
  "dashboard.inventory.adjust",
  "dashboard.inventory.adjust_stock",
  "dashboard.inventory.set_stock",
] as const;

const CATALOG_DESTRUCTIVE_OPERATION_IDS = [
  "dashboard.products.bulk_delete",
  "dashboard.products.trash",
  "dashboard.products.delete_permanently",
  "dashboard.product_variants.retire",
  "dashboard.categories.bulk_delete",
  "dashboard.categories.trash",
  "dashboard.categories.delete_permanently",
  "dashboard.attributes.trash",
  "dashboard.attributes.delete_permanently",
  "dashboard.attributes.bulk_delete",
  "dashboard.attribute_values.delete",
  "dashboard.collections.bulk_delete",
  "dashboard.collections.trash",
  "dashboard.collections.delete_permanently",
] as const;

const CATALOG_REVISION_REQUIRED = new Set([
  "dashboard.products.bulk_delete",
  "dashboard.products.update_section",
  "dashboard.products.update",
  "dashboard.products.trash",
  "dashboard.products.restore",
  "dashboard.products.delete_permanently",
  "dashboard.product_variants.create",
  "dashboard.product_variants.update",
  "dashboard.product_variants.retire",
  "dashboard.product_options.save_matrix",
  "dashboard.categories.bulk_delete",
  "dashboard.categories.bulk_restore",
  "dashboard.categories.update",
  "dashboard.categories.set_status",
  "dashboard.categories.trash",
  "dashboard.categories.delete_permanently",
  "dashboard.categories.restore",
  "dashboard.collections.reorder",
  "dashboard.collections.update",
]);

const CATALOG_IDEMPOTENCY_REQUIRED = new Set([
  "dashboard.inventory.adjust",
  "dashboard.inventory.adjust_stock",
  "dashboard.inventory.set_stock",
]);

const COMMERCE_OPERATION_TUPLES: readonly DashboardOperationTuple[] = [
  ["dashboard.orders.catalog_products", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.list", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.payment_recovery_list", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.quote", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.create", "write", false, "required", "none", "sequential"],
  ["dashboard.orders.archive", "destructive", false, "none", "required", "sequential"],
  ["dashboard.orders.bulk_ship", "write", true, "none", "none", "forbidden"],
  ["dashboard.orders.payment_recovery_link", "security", false, "none", "none", "forbidden"],
  ["dashboard.orders.get", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.update", "write", false, "none", "required", "sequential"],
  ["dashboard.orders.restore", "write", false, "none", "required", "sequential"],
  ["dashboard.orders.items", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.payments", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.notifications", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.notification_retry", "write", true, "none", "none", "forbidden"],
  ["dashboard.orders.notification_resend", "write", true, "required", "none", "forbidden"],
  ["dashboard.orders.form_data", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.update_status", "write", true, "none", "none", "forbidden"],
  ["dashboard.orders.cod_get", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.cod_update", "financial", true, "none", "none", "forbidden"],
  ["dashboard.orders.fulfillment_get", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.fulfill", "write", true, "none", "none", "forbidden"],
  ["dashboard.orders.shipments", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.create_shipment", "write", true, "none", "none", "forbidden"],
  ["dashboard.orders.shipment_get", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.shipment_delete", "destructive", true, "none", "none", "forbidden"],
  ["dashboard.orders.shipment_refresh", "write", true, "none", "none", "forbidden"],
  ["dashboard.orders.shipment_reconcile", "write", true, "none", "none", "forbidden"],
  ["dashboard.orders.refund", "financial", true, "none", "none", "forbidden"],
  ["dashboard.orders.refund_reconcile", "financial", true, "none", "none", "forbidden"],
  ["dashboard.orders.invoice_get", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.invoice_issue", "write", false, "required", "required", "forbidden"],
  ["dashboard.orders.support_request_update", "write", true, "none", "optional", "forbidden"],
  ["dashboard.orders.returns", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.return_get", "read", false, "none", "none", "parallel"],
  ["dashboard.orders.return_create", "write", false, "required", "required", "sequential"],
  ["dashboard.orders.return_approve", "write", false, "required", "required", "sequential"],
  ["dashboard.orders.return_receive", "write", false, "required", "required", "sequential"],
  ["dashboard.orders.return_cancel", "destructive", false, "required", "required", "sequential"],
  ["dashboard.orders.return_reconcile", "write", false, "none", "none", "sequential"],
  ["dashboard.customers.list", "read", false, "none", "none", "parallel"],
  ["dashboard.customers.create", "write", false, "none", "none", "sequential"],
  ["dashboard.customers.bulk_delete", "destructive", false, "none", "none", "forbidden"],
  ["dashboard.customers.get", "read", false, "none", "none", "parallel"],
  ["dashboard.customers.update", "write", false, "none", "none", "sequential"],
  ["dashboard.customers.delete", "destructive", false, "none", "none", "sequential"],
  ["dashboard.customers.delete_permanently", "destructive", false, "none", "none", "forbidden"],
  ["dashboard.customers.restore", "write", false, "none", "none", "sequential"],
  ["dashboard.customers.history", "read", false, "none", "none", "parallel"],
  ["dashboard.abandoned_checkouts.summaries_list", "read", false, "none", "none", "parallel"],
  ["dashboard.abandoned_checkouts.delete", "destructive", false, "none", "none", "forbidden"],
  ["dashboard.discounts.list", "read", false, "none", "none", "parallel"],
  ["dashboard.discounts.create", "write", false, "none", "none", "sequential"],
  ["dashboard.discounts.bulk_delete", "destructive", false, "none", "none", "forbidden"],
  ["dashboard.discounts.bulk_restore", "write", false, "none", "none", "forbidden"],
  ["dashboard.discounts.get", "read", false, "none", "none", "parallel"],
  ["dashboard.discounts.update", "write", false, "none", "required", "sequential"],
  ["dashboard.discounts.delete", "destructive", false, "none", "none", "sequential"],
  ["dashboard.discounts.delete_permanently", "destructive", false, "none", "none", "forbidden"],
  ["dashboard.discounts.set_active", "write", false, "none", "required", "sequential"],
  ["dashboard.discounts.restore", "write", false, "none", "none", "sequential"],
  ["dashboard.promotions.list", "read", false, "none", "none", "parallel"],
  ["dashboard.promotions.create", "write", false, "none", "none", "sequential"],
  ["dashboard.promotions.get", "read", false, "none", "none", "parallel"],
  ["dashboard.promotions.update", "write", false, "none", "required", "sequential"],
  ["dashboard.promotions.preview", "read", false, "none", "required", "parallel"],
  ["dashboard.promotions.activate", "write", false, "none", "required", "sequential"],
  ["dashboard.promotions.pause", "write", false, "none", "required", "sequential"],
  ["dashboard.promotions.archive", "destructive", false, "none", "required", "sequential"],
];

const CHECKOUT_CONFIGURATION_OPERATION_TUPLES: readonly DashboardOperationTuple[] = [
  ["dashboard.checkout_languages.active_get", "read", false, "none", "none", "parallel"],
  ["dashboard.checkout.readiness_get", "read", false, "none", "none", "parallel"],
  ["dashboard.checkout.flow_get", "read", false, "none", "none", "parallel"],
  ["dashboard.checkout.flow_update", "write", false, "none", "required", "sequential"],
  ["dashboard.payments.methods_get", "read", false, "none", "none", "parallel"],
  ["dashboard.payments.methods_update", "write", false, "none", "none", "sequential"],
  ["dashboard.payments.stripe_get", "read", false, "none", "none", "parallel"],
  ["dashboard.payments.stripe_update", "security", false, "none", "none", "forbidden"],
  ["dashboard.payments.sslcommerz_get", "read", false, "none", "none", "parallel"],
  ["dashboard.payments.sslcommerz_update", "security", false, "none", "none", "forbidden"],
  ["dashboard.payments.polar_get", "read", false, "none", "none", "parallel"],
  ["dashboard.payments.polar_update", "security", false, "none", "none", "forbidden"],
  ["dashboard.shipping_methods.list", "read", false, "none", "none", "parallel"],
  ["dashboard.shipping_methods.create", "write", false, "none", "none", "sequential"],
  ["dashboard.shipping_methods.get", "read", false, "none", "none", "parallel"],
  ["dashboard.shipping_methods.update", "write", false, "none", "none", "sequential"],
  ["dashboard.shipping_methods.trash", "destructive", false, "none", "none", "sequential"],
  ["dashboard.shipping_methods.restore", "write", false, "none", "none", "sequential"],
  ["dashboard.shipping_methods.delete_permanently", "destructive", false, "none", "none", "forbidden"],
  ["dashboard.delivery_locations.list", "read", false, "none", "none", "parallel"],
  ["dashboard.delivery_locations.create", "write", false, "none", "none", "sequential"],
  ["dashboard.delivery_locations.bulk_delete", "destructive", false, "none", "none", "forbidden"],
  ["dashboard.delivery_locations.delete_all", "destructive", false, "none", "none", "forbidden"],
  ["dashboard.delivery_locations.get", "read", false, "none", "none", "parallel"],
  ["dashboard.delivery_locations.update", "write", false, "none", "none", "sequential"],
  ["dashboard.delivery_locations.trash", "destructive", false, "none", "none", "sequential"],
  ["dashboard.delivery_locations.pathao_import_chunk", "write", true, "none", "none", "forbidden"],
  ["dashboard.delivery_locations.pathao_import_status", "read", false, "none", "none", "parallel"],
  ["dashboard.delivery_locations.pathao_import_reset", "write", false, "none", "none", "forbidden"],
  ["dashboard.customer_requests.policy_get", "read", false, "none", "none", "parallel"],
  ["dashboard.customer_requests.policy_update", "write", false, "none", "none", "sequential"],
  ["dashboard.notifications.customer_rules_get", "read", false, "none", "none", "parallel"],
  ["dashboard.notifications.customer_rules_update", "write", false, "none", "none", "sequential"],
  ["dashboard.notifications.admin_rules_get", "read", false, "none", "none", "parallel"],
  ["dashboard.notifications.admin_rules_update", "write", false, "none", "none", "sequential"],
  ["dashboard.notifications.firebase_get", "read", false, "none", "none", "parallel"],
  ["dashboard.notifications.firebase_update", "security", false, "none", "none", "forbidden"],
  ["dashboard.taxes.settings_get", "read", false, "none", "none", "parallel"],
  ["dashboard.taxes.settings_update", "write", false, "none", "required", "sequential"],
  ["dashboard.taxes.classes_list", "read", false, "none", "none", "parallel"],
  ["dashboard.taxes.classes_create", "write", false, "none", "none", "sequential"],
  ["dashboard.taxes.classes_update", "write", false, "none", "required", "sequential"],
  ["dashboard.taxes.classes_delete", "destructive", false, "none", "required", "sequential"],
  ["dashboard.taxes.rates_list", "read", false, "none", "none", "parallel"],
  ["dashboard.taxes.rates_create", "write", false, "none", "none", "sequential"],
  ["dashboard.taxes.rates_update", "write", false, "none", "required", "sequential"],
  ["dashboard.taxes.rates_delete", "destructive", false, "none", "required", "sequential"],
  ["dashboard.taxes.jurisdictions_list", "read", false, "none", "none", "parallel"],
  ["dashboard.taxes.classifications_list", "read", false, "none", "none", "parallel"],
  ["dashboard.taxes.classifications_update", "write", false, "none", "required", "sequential"],
  ["dashboard.taxes.preview", "read", false, "none", "none", "parallel"],
];

const PLATFORM_SETTINGS_OPERATION_TUPLES: readonly DashboardOperationTuple[] = [
  ["dashboard.home.summary", "read", false, "none", "none", "parallel"],
  ["dashboard.home.metrics", "read", false, "none", "none", "parallel"],
  ["dashboard.home.full_summary", "read", false, "none", "none", "parallel"],
  ["dashboard.home.activity", "read", false, "none", "none", "parallel"],
  ["dashboard.cache.groups_list", "read", false, "none", "none", "parallel"],
  ["dashboard.cache.purge_all", "write", false, "none", "none", "sequential"],
  ["dashboard.cache.purge_groups", "write", false, "none", "none", "sequential"],
  ["dashboard.settings.business_get", "read", false, "none", "none", "parallel"],
  ["dashboard.settings.business_update", "write", false, "none", "none", "sequential"],
  ["dashboard.settings.currency_get", "read", false, "none", "none", "parallel"],
  ["dashboard.settings.currency_update", "write", false, "none", "none", "sequential"],
  ["dashboard.settings.media_delivery_get", "read", false, "none", "none", "parallel"],
  ["dashboard.settings.media_delivery_update", "write", false, "none", "none", "sequential"],
  ["dashboard.settings.storefront_url_get", "read", false, "none", "none", "parallel"],
  ["dashboard.settings.storefront_url_update", "write", false, "none", "none", "sequential"],
  ["dashboard.settings.customer_countries_get", "read", false, "none", "none", "parallel"],
  ["dashboard.settings.customer_countries_update", "write", false, "none", "none", "sequential"],
  ["dashboard.seo.settings_get", "read", false, "none", "none", "parallel"],
  ["dashboard.seo.settings_update", "write", false, "none", "none", "sequential"],
  ["dashboard.seo.feed_diagnostics", "read", false, "none", "none", "parallel"],
  ["dashboard.seo.live_probe", "read", true, "none", "none", "sequential"],
  ["dashboard.security.policy_get", "read", false, "none", "none", "parallel"],
  ["dashboard.security.policy_update", "security", false, "none", "none", "sequential"],
  ["dashboard.security.runtime_sources", "read", false, "none", "none", "parallel"],
];

const PLATFORM_SETTINGS_BOUNDS: Readonly<
  Record<string, { request: number; response: number }>
> = {
  "dashboard.home.summary": { request: 16_384, response: 65_536 },
  "dashboard.home.metrics": { request: 16_384, response: 16_384 },
  "dashboard.home.full_summary": { request: 16_384, response: 65_536 },
  "dashboard.home.activity": { request: 16_384, response: 32_768 },
  "dashboard.cache.groups_list": { request: 16_384, response: 65_536 },
  "dashboard.cache.purge_all": { request: 16_384, response: 8_192 },
  "dashboard.cache.purge_groups": { request: 16_384, response: 8_192 },
  "dashboard.settings.business_get": { request: 16_384, response: 16_384 },
  "dashboard.settings.business_update": { request: 16_384, response: 8_192 },
  "dashboard.settings.currency_get": { request: 16_384, response: 8_192 },
  "dashboard.settings.currency_update": { request: 16_384, response: 8_192 },
  "dashboard.settings.media_delivery_get": { request: 16_384, response: 16_384 },
  "dashboard.settings.media_delivery_update": { request: 16_384, response: 16_384 },
  "dashboard.settings.storefront_url_get": { request: 16_384, response: 8_192 },
  "dashboard.settings.storefront_url_update": { request: 16_384, response: 8_192 },
  "dashboard.settings.customer_countries_get": { request: 16_384, response: 16_384 },
  "dashboard.settings.customer_countries_update": { request: 16_384, response: 8_192 },
  "dashboard.seo.settings_get": { request: 16_384, response: 65_536 },
  "dashboard.seo.settings_update": { request: 65_536, response: 16_384 },
  "dashboard.seo.feed_diagnostics": { request: 16_384, response: 65_536 },
  "dashboard.seo.live_probe": { request: 16_384, response: 65_536 },
  "dashboard.security.policy_get": { request: 16_384, response: 65_536 },
  "dashboard.security.policy_update": { request: 131_072, response: 8_192 },
  "dashboard.security.runtime_sources": { request: 16_384, response: 16_384 },
};

const BOUNDED_SETTINGS_OPERATION_POLICIES: ReadonlyArray<readonly [
  operationId: string,
  options: Parameters<typeof dashboardOperationMetadata>[1],
]> = [
  ["dashboard.settings.customer_auth_get", { risk: "security", batch: "sequential", maxRequestBytes: 16_384, maximumResponseBytes: 8_192 }],
  ["dashboard.settings.customer_auth_update", { risk: "security", batch: "sequential", maxRequestBytes: 16_384, maximumResponseBytes: 8_192 }],
  ["dashboard.settings.email_get", { risk: "security", batch: "sequential", maxRequestBytes: 16_384, maximumResponseBytes: 8_192 }],
  ["dashboard.settings.email_update", { risk: "security", batch: "sequential", maxRequestBytes: 16_384, maximumResponseBytes: 8_192 }],
  ["dashboard.settings_sms.get_sms", { risk: "security", batch: "sequential", maxRequestBytes: 16_384, maximumResponseBytes: 8_192 }],
  ["dashboard.settings_sms.sms", { risk: "security", batch: "sequential", maxRequestBytes: 16_384, maximumResponseBytes: 8_192 }],
  ["dashboard.settings_header.get_header", { risk: "read", maxRequestBytes: 16_384, maximumResponseBytes: 65_536 }],
  ["dashboard.settings_header.header", { risk: "write", revision: "required", maxRequestBytes: 65_536, maximumResponseBytes: 8_192 }],
  ["dashboard.settings_footer.get_footer", { risk: "read", maxRequestBytes: 16_384, maximumResponseBytes: 65_536 }],
  ["dashboard.settings_footer.footer", { risk: "write", revision: "required", maxRequestBytes: 65_536, maximumResponseBytes: 8_192 }],
  ["dashboard.settings_homepage_presentation.get_homepage_presentation", { risk: "read", maxRequestBytes: 16_384, maximumResponseBytes: 8_192 }],
  ["dashboard.settings_homepage_presentation.homepage_presentation", { risk: "write", revision: "required", maxRequestBytes: 16_384, maximumResponseBytes: 8_192 }],
];

const CHECKOUT_LANGUAGE_OPERATION_POLICIES: ReadonlyArray<readonly [
  operationId: string,
  options: Parameters<typeof dashboardOperationMetadata>[1],
]> = [
  ["dashboard.checkout_languages.list", { risk: "read", maxRequestBytes: 16_384, maximumResponseBytes: 65_536 }],
  ["dashboard.checkout_languages.create", { risk: "write", maxRequestBytes: 65_536, maximumResponseBytes: 16_384 }],
  ["dashboard.checkout_languages.get", { risk: "read", maxRequestBytes: 16_384, maximumResponseBytes: 16_384 }],
  ["dashboard.checkout_languages.update", { risk: "write", maxRequestBytes: 65_536, maximumResponseBytes: 16_384 }],
  ["dashboard.checkout_languages.trash", { risk: "destructive", maxRequestBytes: 16_384, maximumResponseBytes: 8_192 }],
  ["dashboard.checkout_languages.delete_permanently", { risk: "destructive", batch: "forbidden", maxRequestBytes: 16_384, maximumResponseBytes: 8_192 }],
  ["dashboard.checkout_languages.restore", { risk: "write", maxRequestBytes: 16_384, maximumResponseBytes: 8_192 }],
  ["dashboard.notifications.fcm_device_register", { risk: "security", exposure: "device", batch: "forbidden", maxRequestBytes: 16_384, maximumResponseBytes: 8_192 }],
];

const LIVE_BROWSER_OPERATION_POLICIES: ReadonlyArray<readonly [
  operationId: string,
  options: Parameters<typeof dashboardOperationMetadata>[1],
]> = [
  ["dashboard.analytics.list", { risk: "read", maximumResponseBytes: 65_536 }],
  ["dashboard.analytics.health", { risk: "read", maximumResponseBytes: 16_384 }],
  ["dashboard.analytics.get", { risk: "read", maximumResponseBytes: 65_536 }],
  ["dashboard.analytics.create", { risk: "write", revision: "none" }],
  ["dashboard.analytics.update", { risk: "write", revision: "required" }],
  ["dashboard.analytics.set_active", { risk: "write", revision: "required", openWorld: true, batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.analytics.trash", { risk: "destructive", revision: "required", maximumResponseBytes: 16_384 }],
  ["dashboard.analytics.restore", { risk: "write", revision: "required", maximumResponseBytes: 16_384 }],
  ["dashboard.analytics.delete_permanently", { risk: "destructive", revision: "required", maximumResponseBytes: 16_384 }],
  ["dashboard.meta_conversions.get", { risk: "read", maximumResponseBytes: 16_384 }],
  ["dashboard.meta_conversions.update", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.meta_conversions.logs_list", { risk: "read" }],
  ["dashboard.meta_conversions.logs_clear", { risk: "destructive", maximumResponseBytes: 16_384 }],
  ["dashboard.meta_conversions.logs_cleanup", { risk: "destructive", maximumResponseBytes: 16_384 }],
  ["dashboard.delivery_providers.list", { risk: "read" }],
  ["dashboard.delivery_providers.get", { risk: "read", maximumResponseBytes: 16_384 }],
  ["dashboard.delivery_providers.create", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.delivery_providers.update", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.delivery_providers.test_credentials", { risk: "security", openWorld: true, batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.delivery_providers.test", { risk: "security", openWorld: true, batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.delivery_providers.delete", { risk: "destructive", maximumResponseBytes: 16_384 }],
  ["dashboard.fraud_providers.list", { risk: "read" }],
  ["dashboard.fraud_providers.create", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.fraud_providers.update", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.fraud_providers.delete", { risk: "destructive", maximumResponseBytes: 16_384 }],
  ["dashboard.fraud_providers.test", { risk: "security", openWorld: true, batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.fraud_lookup.run", { risk: "read", openWorld: true, batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.team.users.list", { risk: "read" }],
  ["dashboard.team.users.invite", { risk: "security", openWorld: true, batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.team.users.resend_invitation", { risk: "security", openWorld: true, batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.team.users.revoke_invitation", { risk: "destructive", maximumResponseBytes: 16_384 }],
  ["dashboard.team.users.set_suspension", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.team.roles.list", { risk: "read" }],
  ["dashboard.team.roles.get", { risk: "read", maximumResponseBytes: 16_384 }],
  ["dashboard.team.permissions.list", { risk: "read" }],
  ["dashboard.account.permissions.get", { risk: "read", maximumResponseBytes: 16_384 }],
  ["dashboard.team.roles.create", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.team.roles.update", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.team.user_roles.assign", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.team.user_roles.remove", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.team.permission_overrides.set", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.team.permission_overrides.remove", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.team.roles.delete", { risk: "destructive", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.account.profile_update", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.account.two_factor.get", { risk: "read", maximumResponseBytes: 16_384 }],
  ["dashboard.account.sessions.list", { risk: "read" }],
  ["dashboard.account.sessions.revoke", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.account.sessions.revoke_others", { risk: "security", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.account.security_get", { risk: "read", maximumResponseBytes: 16_384 }],
  ["dashboard.account.password_change", { risk: "security", exposure: "device", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.account.two_factor.method_challenge", { risk: "security", exposure: "device", batch: "forbidden", sensitiveOutput: true, maximumResponseBytes: 16_384 }],
  ["dashboard.account.two_factor.method_update", { risk: "security", exposure: "device", batch: "forbidden", sensitiveOutput: true, maximumResponseBytes: 16_384 }],
  ["dashboard.account.two_factor.verify", { risk: "security", exposure: "device", batch: "forbidden", maximumResponseBytes: 16_384 }],
  ["dashboard.scanner_device.create_link", { risk: "security", exposure: "device", batch: "forbidden", sensitiveOutput: true, maximumResponseBytes: 16_384 }],
];

const FOUNDATION_STOREFRONT_READ_BOUNDS = [
  ["storefront.products.list", 65_536],
  ["storefront.products.get_section", 61_440],
  ["storefront.categories.list_summaries", 65_536],
  ["storefront.categories.get_section", 32_768],
  ["storefront.categories.list_product_summaries", 65_536],
  ["storefront.collections.list", 65_536],
  ["storefront.collections.get", 65_536],
  ["storefront.search.predict", 32_768],
  ["storefront.attributes.list_filterable", 65_536],
  ["storefront.attributes.list_for_category", 65_536],
  ["storefront.attributes.list_for_search", 65_536],
  ["storefront.locations.city_summaries", 32_768],
  ["storefront.locations.zone_summaries", 32_768],
  ["storefront.locations.area_summaries", 32_768],
  ["storefront.shipping_methods.list", 32_768],
  ["storefront.homepage.get", 65_536],
  ["storefront.layout.get", 65_536],
  ["storefront.checkout.get_config", 16_384],
  ["storefront.checkout_language.get_active", 16_384],
  ["storefront.seo.get", 32_768],
] as const;

const FOUNDATION_STOREFRONT_EXCLUSIONS = {
  "storefront.locations.cities":
    "Unbounded browser location aggregate; use storefront.locations.city_summaries.",
  "storefront.locations.zones":
    "Unbounded browser location aggregate; use storefront.locations.zone_summaries.",
  "storefront.locations.areas":
    "Unbounded browser location aggregate; use storefront.locations.area_summaries.",
  "storefront.categories.list":
    "Unbounded browser category aggregate can exceed the structured-result ceiling; use storefront.categories.list_summaries plus storefront.categories.get_section.",
  "storefront.categories.get":
    "Unbounded browser category aggregate; use storefront.categories.get_section for reconstructable bounded detail.",
  "storefront.categories.list_products":
    "Browser category listing embeds the unbounded category aggregate; use storefront.categories.list_product_summaries plus storefront.categories.get_section.",
  "storefront.products.get":
    "Unbounded browser page aggregate; use storefront.products.get_section for reconstructable bounded detail.",
  "storefront.products.search_legacy":
    "Legacy variant aggregate duplicates storefront.products.list plus storefront.products.get_section.",
  "storefront.attributes.category_id_alias":
    "ID compatibility alias; use storefront.attributes.list_for_category with the public category slug.",
  "storefront.layout.header_alias":
    "Compatibility alias; storefront.layout.get is the canonical buyer-shell authority.",
  "storefront.layout.footer_alias":
    "Compatibility alias; storefront.layout.get is the canonical buyer-shell authority.",
  "storefront.pages.render_by_slug_alias":
    "Storefront render-helper duplicate; use storefront.pages.get_by_slug as the canonical page-content authority.",
} as const;

const AUDITED_INFRASTRUCTURE_EXCLUSIONS = {
  "dashboard.agent_access_authorization_requests.get": reviewedExclusionMetadata(
    "dashboard.agent_access_authorization_requests.get",
    {
      surface: "dashboard",
      principals: ["admin"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 16_384,
      sensitiveOutput: false,
      exclusionReason:
        "Human OAuth consent display; unconsumed third-party client metadata is available only in the interactive dashboard consent flow.",
    },
  ),
  "dashboard.agent_access_authorization_requests_approve.approve": reviewedExclusionMetadata(
    "dashboard.agent_access_authorization_requests_approve.approve",
    {
      surface: "dashboard",
      principals: ["admin"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 65_536,
      sensitiveOutput: true,
      exclusionReason:
        "Human OAuth approval and protocol continuation require a live 2FA-verified Super Admin browser session.",
    },
  ),
  "dashboard.agent_access_authorization_requests_deny.deny": reviewedExclusionMetadata(
    "dashboard.agent_access_authorization_requests_deny.deny",
    {
      surface: "dashboard",
      principals: ["admin"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 16_384,
      sensitiveOutput: true,
      exclusionReason:
        "Human OAuth denial and protocol continuation require a live 2FA-verified Super Admin browser session.",
    },
  ),
  "dashboard.agent_access_device_authorizations_lookup.lookup": reviewedExclusionMetadata(
    "dashboard.agent_access_device_authorizations_lookup.lookup",
    {
      surface: "dashboard",
      principals: ["admin"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 4_096,
      sensitiveOutput: false,
      exclusionReason:
        "Human device-pairing verification accepts the short-lived user code only in the interactive dashboard pairing flow.",
    },
  ),
  "dashboard.agent_access_device_authorizations_approve.approve": reviewedExclusionMetadata(
    "dashboard.agent_access_device_authorizations_approve.approve",
    {
      surface: "dashboard",
      principals: ["admin"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 65_536,
      sensitiveOutput: false,
      exclusionReason:
        "Human device-pairing approval mints a CLI credential for encrypted one-time delivery and requires live 2FA-verified Super Admin consent.",
    },
  ),
  "dashboard.agent_access_device_authorizations_deny.deny": reviewedExclusionMetadata(
    "dashboard.agent_access_device_authorizations_deny.deny",
    {
      surface: "dashboard",
      principals: ["admin"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 16_384,
      sensitiveOutput: false,
      exclusionReason:
        "Human device-pairing denial requires live 2FA-verified Super Admin consent.",
    },
  ),
  "dashboard.agent_access_revoke_all.revoke_all": reviewedExclusionMetadata(
    "dashboard.agent_access_revoke_all.revoke_all",
    {
      surface: "dashboard",
      principals: ["admin"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 16_384,
      sensitiveOutput: false,
      exclusionReason:
        "Emergency tenant-wide credential kill switch; only a live 2FA-verified Super Admin browser session may invoke it.",
    },
  ),
  "system.auth_token.get_token": reviewedExclusionMetadata(
    "system.auth_token.get_token",
    {
      surface: "system",
      principals: ["internal"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 16_384,
      sensitiveOutput: true,
      exclusionReason:
        "Static X-API-Token exchange that mints a short-lived service JWT; it is infrastructure authentication, not an agent grant or merchant capability, and its bearer output must not enter agent results.",
    },
  ),
  "system.auth_firebase_config.get_firebase_config": reviewedExclusionMetadata(
    "system.auth_firebase_config.get_firebase_config",
    {
      surface: "system",
      principals: ["internal"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Public Firebase browser and worker bootstrap configuration; not a semantic merchant or storefront action.",
    },
  ),
  "system.auth_me.get_me": reviewedExclusionMetadata(
    "system.auth_me.get_me",
    {
      surface: "system",
      principals: ["internal"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Legacy service-JWT claim introspection; agent identity comes from the live agent grant and principal.",
    },
  ),
  "system.auth_revoke.revoke": reviewedExclusionMetadata(
    "system.auth_revoke.revoke",
    {
      surface: "system",
      principals: ["internal"],
      risk: "security",
      openWorld: false,
      idempotency: "supported",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Legacy service-JWT KV blacklist revocation; use agent credential self-revoke or agent-access grant management.",
    },
  ),
  "system.auth_token_stats.get_token_stats": reviewedExclusionMetadata(
    "system.auth_token_stats.get_token_stats",
    {
      surface: "system",
      principals: ["internal"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Legacy JWT secret and blacklist diagnostics; not merchant-visible functionality or agent authentication state.",
    },
  ),
  "system.setup.get_setup": reviewedExclusionMetadata(
    "system.setup.get_setup",
    {
      surface: "system",
      principals: ["internal"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 16_384,
      sensitiveOutput: false,
      exclusionReason:
        "Unauthenticated first-deployment readiness probe; setup is complete before an agent grant can exist.",
    },
  ),
  "system.setup.setup": reviewedExclusionMetadata(
    "system.setup.setup",
    {
      surface: "system",
      principals: ["internal"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 16_384,
      sensitiveOutput: false,
      exclusionReason:
        "Unauthenticated first-admin credential bootstrap belongs to the setup ceremony and must not accept agent input.",
    },
  ),
  "storefront.abandoned_checkouts.abandoned_checkouts": reviewedExclusionMetadata(
    "storefront.abandoned_checkouts.abandoned_checkouts",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "write",
      openWorld: false,
      idempotency: "supported",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Debounced browser form snapshot telemetry stores arbitrary checkout JSON and optional buyer phone; agent storefront context is the canonical cart and checkout state.",
    },
  ),
  "storefront.abandoned_checkouts_cleanup.cleanup": reviewedExclusionMetadata(
    "storefront.abandoned_checkouts_cleanup.cleanup",
    {
      surface: "storefront",
      principals: ["internal"],
      risk: "destructive",
      openWorld: false,
      idempotency: "supported",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Service-authenticated post-order browser-checkout cleanup is automatic lifecycle maintenance, not a buyer action.",
    },
  ),
  "storefront.analytics_configurations.get_configurations": reviewedExclusionMetadata(
    "storefront.analytics_configurations.get_configurations",
    {
      surface: "storefront",
      principals: ["internal"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Processed analytics snippets and trusted custom browser code are rendering infrastructure, not structured agent data.",
    },
  ),
  "storefront.meta_events.events": reviewedExclusionMetadata(
    "storefront.meta_events.events",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "write",
      openWorld: true,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Browser analytics ingestion forwards browser-derived events and user data to Meta CAPI; agents must not fabricate browser telemetry.",
    },
  ),
  "storefront.ptproxy.get_ptproxy": reviewedExclusionMetadata(
    "storefront.ptproxy.get_ptproxy",
    {
      surface: "storefront",
      principals: ["internal"],
      risk: "read",
      openWorld: true,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Allowlisted Partytown script reverse proxy is browser transport infrastructure, not a semantic agent operation.",
    },
  ),
  "storefront.products_feed.get_feed": reviewedExclusionMetadata(
    "storefront.products_feed.get_feed",
    {
      surface: "storefront",
      principals: ["internal"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Crawler-only Merchant XML feed projection; agents use canonical catalog list, search, and bounded detail operations.",
    },
  ),
  "storefront.products_sitemap.get_sitemap": reviewedExclusionMetadata(
    "storefront.products_sitemap.get_sitemap",
    {
      surface: "storefront",
      principals: ["internal"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Crawler-only sitemap projection is discovery infrastructure, not a buyer-visible catalog capability.",
    },
  ),
  "storefront.storefront_csp.get_csp": reviewedExclusionMetadata(
    "storefront.storefront_csp.get_csp",
    {
      surface: "storefront",
      principals: ["internal"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Storefront CSP-domain configuration is consumed by response middleware to build browser security headers, not as a semantic storefront read.",
    },
  ),
} as const;

const AUDITED_STOREFRONT_LEGACY_EXCLUSIONS = {
  "storefront.customer_auth_send_otp.send_otp": reviewedExclusionMetadata(
    "storefront.customer_auth_send_otp.send_otp",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "security",
      openWorld: true,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Browser OTP start accepts buyer identifiers and dispatches email or SMS; use storefront.customer_auth.begin and status so identifiers, OTPs, and session material stay outside agent I/O.",
    },
  ),
  "storefront.customer_auth_verify_otp.verify_otp": reviewedExclusionMetadata(
    "storefront.customer_auth_verify_otp.verify_otp",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Accepts a raw OTP and issues the customer session cookie; authentication must complete in the hosted storefront.customer_auth continuation.",
    },
  ),
  "storefront.customer_auth_me.get_me": reviewedExclusionMetadata(
    "storefront.customer_auth_me.get_me",
    {
      surface: "storefront",
      principals: ["customer"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Legacy customer-cookie PII projection; use the live delegated-authority storefront.customer_profile.get operation.",
    },
  ),
  "storefront.customer_auth_logout.logout": reviewedExclusionMetadata(
    "storefront.customer_auth_logout.logout",
    {
      surface: "storefront",
      principals: ["customer"],
      risk: "security",
      openWorld: false,
      idempotency: "supported",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Revokes the browser customer-cookie session; use storefront.customer_auth.logout for context-bound customer authority.",
    },
  ),
  "storefront.customer_auth_profile.replace_profile": reviewedExclusionMetadata(
    "storefront.customer_auth_profile.replace_profile",
    {
      surface: "storefront",
      principals: ["customer"],
      risk: "write",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Cookie-authorized browser profile mutation returning PII; use storefront.customer_profile.update with live delegated authority.",
    },
  ),
  "storefront.customer_auth_orders.get_orders": reviewedExclusionMetadata(
    "storefront.customer_auth_orders.get_orders",
    {
      surface: "storefront",
      principals: ["customer"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Private customer-cookie account-order projection; use the context-bound storefront.orders.list operation.",
    },
  ),
  "storefront.customer_auth_orders.get": reviewedExclusionMetadata(
    "storefront.customer_auth_orders.get",
    {
      surface: "storefront",
      principals: ["customer"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Private customer-cookie order detail projection; use storefront.orders.get with delegated immutable customer ownership.",
    },
  ),
  "storefront.customer_auth_orders_support_requests.support_requests": reviewedExclusionMetadata(
    "storefront.customer_auth_orders_support_requests.support_requests",
    {
      surface: "storefront",
      principals: ["customer"],
      risk: "write",
      openWorld: true,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Customer-cookie support mutation is duplicated by storefront.orders.support_request.create, which preserves delegated ownership and notification delivery.",
    },
  ),
  "storefront.customer_auth_orders_payment_session.payment_session": reviewedExclusionMetadata(
    "storefront.customer_auth_orders_payment_session.payment_session",
    {
      surface: "storefront",
      principals: ["customer"],
      risk: "financial",
      openWorld: true,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Returns provider client-secret or hosted-session material; use storefront.orders.payment.begin and storefront.payment.status with secure browser continuation.",
    },
  ),
  "storefront.discounts_validate.validate": reviewedExclusionMetadata(
    "storefront.discounts_validate.validate",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Legacy browser helper accepts client-asserted cart values and buyer phone; use storefront.discount.apply against the server-owned context cart.",
    },
  ),
  "storefront.orders_status.get": reviewedExclusionMetadata(
    "storefront.orders_status.get",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Opaque browser checkout-attempt polling is transport recovery; retry storefront.checkout.submit with the same idempotency key or use continuation status.",
    },
  ),
  "storefront.orders_payment_recovery_send_otp.send_otp": reviewedExclusionMetadata(
    "storefront.orders_payment_recovery_send_otp.send_otp",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "security",
      openWorld: true,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Starts private-order buyer verification; use storefront.payment_recovery.begin and status so identity and OTP state remain in the hosted continuation.",
    },
  ),
  "storefront.orders_payment_recovery_verify_otp.verify_otp": reviewedExclusionMetadata(
    "storefront.orders_payment_recovery_verify_otp.verify_otp",
    {
      surface: "storefront",
      principals: ["internal"],
      risk: "security",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Service-authenticated storefront proxy accepts a raw OTP and returns a private receipt bearer; use the hosted storefront.payment_recovery continuation.",
    },
  ),
  "storefront.orders_receipt.get": reviewedExclusionMetadata(
    "storefront.orders_receipt.get",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Private receipt projection requires raw receipt-bearer authority; use storefront.receipt.get through the context-to-receipt grant.",
    },
  ),
  "storefront.orders_receipt_support_requests.support_requests": reviewedExclusionMetadata(
    "storefront.orders_receipt_support_requests.support_requests",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "write",
      openWorld: true,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Requires raw receipt proof in the request; use storefront.orders.support_request.create with stored receipt-hash or customer authority.",
    },
  ),
  "storefront.orders_cart_validation.cart_validation": reviewedExclusionMetadata(
    "storefront.orders_cart_validation.cart_validation",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Legacy stateless browser cart preflight; use storefront.checkout.validate against authoritative context lines and delivery state.",
    },
  ),
  "storefront.orders_tax_quote.tax_quote": reviewedExclusionMetadata(
    "storefront.orders_tax_quote.tax_quote",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "read",
      openWorld: false,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Legacy stateless browser quote accepts client cart and buyer facts; use storefront.checkout.quote against server-owned context state.",
    },
  ),
  "storefront.orders.orders": reviewedExclusionMetadata(
    "storefront.orders.orders",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "financial",
      openWorld: false,
      idempotency: "required",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Legacy browser checkout accepts client-owned cart and buyer state and returns bearer tokens; use revision-checked, idempotent storefront.checkout.submit.",
    },
  ),
  "storefront.payment_stripe_intent.intent": reviewedExclusionMetadata(
    "storefront.payment_stripe_intent.intent",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "financial",
      openWorld: true,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Requires raw receipt proof and returns a Stripe client secret; use the secure storefront payment continuation.",
    },
  ),
  "storefront.payment_stripe_reconcile.reconcile": reviewedExclusionMetadata(
    "storefront.payment_stripe_reconcile.reconcile",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "financial",
      openWorld: true,
      idempotency: "supported",
      transport: "json",
      sensitiveOutput: false,
      exclusionReason:
        "Provider reconciliation requires raw receipt proof; storefront.payment.status owns context-authorized safe reconciliation.",
    },
  ),
  "storefront.payment_sslcommerz_session.session": reviewedExclusionMetadata(
    "storefront.payment_sslcommerz_session.session",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "financial",
      openWorld: true,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Requires raw receipt proof and returns hosted SSLCommerz session material; use the secure storefront payment continuation.",
    },
  ),
  "storefront.payment_polar_session.session": reviewedExclusionMetadata(
    "storefront.payment_polar_session.session",
    {
      surface: "storefront",
      principals: ["visitor", "customer"],
      risk: "financial",
      openWorld: true,
      idempotency: "none",
      transport: "json",
      sensitiveOutput: true,
      exclusionReason:
        "Requires raw receipt proof and returns hosted Polar checkout material; use the secure storefront payment continuation.",
    },
  ),
} as const;

const REVIEWED_AGENT_OPERATIONS_BY_ID: Readonly<
  Record<string, { operationId: string; metadata: AgentOperationMetadata }>
> = {
  ...AUDITED_INFRASTRUCTURE_EXCLUSIONS,
  ...AUDITED_STOREFRONT_LEGACY_EXCLUSIONS,
  ...Object.fromEntries(FOUNDATION_STOREFRONT_READ_BOUNDS.map(
    ([operationId, maximumResponseBytes]) => [
      operationId,
      storefrontReadMetadata(operationId, maximumResponseBytes, 16_384),
    ],
  )),
  ...Object.fromEntries(Object.entries(FOUNDATION_STOREFRONT_EXCLUSIONS).map(
    ([operationId, exclusionReason]) => [
      operationId,
      reviewedExclusionMetadata(operationId, {
        surface: "storefront",
        principals: ["visitor", "customer"],
        risk: "read",
        openWorld: false,
        idempotency: "none",
        transport: "json",
        maxRequestBytes: 16_384,
        sensitiveOutput: false,
        exclusionReason,
      }),
    ],
  )),
  ...reviewedEntries(CATALOG_READ_OPERATION_IDS, (operationId) =>
    dashboardOperationMetadata(operationId, {
      risk: "read",
      maximumResponseBytes:
        operationId === "dashboard.products.get_section" ||
          operationId === "dashboard.collections.get_section" ? 65_536 : undefined,
    })),
  ...reviewedEntries(CATALOG_WRITE_OPERATION_IDS, (operationId) =>
    dashboardOperationMetadata(operationId, {
      risk: "write",
      revision: CATALOG_REVISION_REQUIRED.has(operationId) ? "required" : "none",
      idempotency: CATALOG_IDEMPOTENCY_REQUIRED.has(operationId) ? "required" : "none",
      maximumResponseBytes:
        operationId === "dashboard.products.update_section" ? 16_384 : undefined,
      maxRequestBytes:
        operationId === "dashboard.products.update_section" ? 16_384 : undefined,
    })),
  ...reviewedEntries(CATALOG_DESTRUCTIVE_OPERATION_IDS, (operationId) =>
    dashboardOperationMetadata(operationId, {
      risk: "destructive",
      revision: CATALOG_REVISION_REQUIRED.has(operationId) ? "required" : "none",
    })),
  "dashboard.products.get": dashboardOperationMetadata(
    "dashboard.products.get",
    {
      risk: "read",
      exposure: "excluded",
      exclusionReason:
        "Legacy oversized aggregate projection; use dashboard.products.get_section.",
    },
  ),
  "dashboard.products.list": dashboardOperationMetadata(
    "dashboard.products.list",
    {
      risk: "read",
      exposure: "excluded",
      exclusionReason:
        "Legacy dashboard list may include oversized rich text and media projections; use dashboard.products.list_summaries.",
    },
  ),
  "dashboard.categories.list": dashboardOperationMetadata(
    "dashboard.categories.list",
    {
      risk: "read",
      exposure: "excluded",
      exclusionReason:
        "Legacy dashboard list may include oversized category rich text; use dashboard.categories.list_summaries.",
    },
  ),
  "dashboard.categories.get": dashboardOperationMetadata(
    "dashboard.categories.get",
    {
      risk: "read",
      exposure: "excluded",
      exclusionReason:
        "Legacy oversized category aggregate; use dashboard.categories.get_section.",
    },
  ),
  "dashboard.attributes.list": dashboardOperationMetadata(
    "dashboard.attributes.list",
    {
      risk: "read",
      exposure: "excluded",
      exclusionReason:
        "Legacy dashboard list may include up to 500 preset values per attribute; use dashboard.attributes.list_summaries and dashboard.attribute_values.list.",
    },
  ),
  "dashboard.collections.get": dashboardOperationMetadata(
    "dashboard.collections.get",
    {
      risk: "read",
      exposure: "excluded",
      exclusionReason:
        "Legacy oversized aggregate projection; use dashboard.collections.get_section.",
    },
  ),
  "dashboard.inventory_labels.generate_artifact": dashboardOperationMetadata(
    "dashboard.inventory_labels.generate_artifact",
    {
      risk: "read",
      exposure: "execute",
      batch: "forbidden",
      transport: "json",
      artifactOutput: {
        mediaTypes: ["application/pdf", "text/csv", "text/html"],
        disposition: "attachment",
        filenamePolicy: "content-disposition",
        maxArtifactBytes: 16 * 1024 * 1024,
        delivery: "authenticated-handle",
      },
    },
  ),
  "dashboard.inventory.movements_export": dashboardOperationMetadata(
    "dashboard.inventory.movements_export",
    {
      risk: "read",
      batch: "forbidden",
      transport: "json",
      maxRequestBytes: 16_384,
      maximumResponseBytes: 65_536,
      artifactOutput: {
        mediaTypes: ["text/csv"],
        disposition: "attachment",
        filenamePolicy: "content-disposition",
        maxArtifactBytes: 16 * 1024 * 1024,
        delivery: "authenticated-handle",
      },
    },
  ),
  "dashboard.search.get_search": dashboardOperationMetadata(
    "dashboard.search.get_search",
    {
      risk: "read",
      exposure: "excluded",
      exclusionReason:
        "Legacy cross-resource search is unused by the dashboard; authoritative bounded product, category, and page list operations provide merchant search and filtering.",
    },
  ),
  "dashboard.search_reindex.reindex": dashboardOperationMetadata(
    "dashboard.search_reindex.reindex",
    {
      risk: "write",
      exposure: "excluded",
      exclusionReason:
        "Placeholder returns ‘Reindex initiated’ without scheduling or performing reindex work; execution would report a false side effect.",
    },
  ),
  ...dashboardTupleEntries(COMMERCE_OPERATION_TUPLES),
  ...dashboardTupleEntries(CHECKOUT_CONFIGURATION_OPERATION_TUPLES),
  ...Object.fromEntries(PLATFORM_SETTINGS_OPERATION_TUPLES.map(([
    operationId,
    risk,
    openWorld,
    idempotency,
    revision,
    batch,
  ]) => {
    const bounds = PLATFORM_SETTINGS_BOUNDS[operationId];
    return [
      operationId,
      dashboardOperationMetadata(operationId, {
        risk,
        openWorld,
        idempotency,
        revision,
        batch,
        maxRequestBytes: bounds?.request,
        maximumResponseBytes: bounds?.response,
      }),
    ];
  })),
  ...Object.fromEntries(LIVE_BROWSER_OPERATION_POLICIES.map(
    ([operationId, options]) => [
      operationId,
      dashboardOperationMetadata(operationId, options),
    ],
  )),
  ...Object.fromEntries(BOUNDED_SETTINGS_OPERATION_POLICIES.map(
    ([operationId, options]) => [
      operationId,
      dashboardOperationMetadata(operationId, options),
    ],
  )),
  ...Object.fromEntries(CHECKOUT_LANGUAGE_OPERATION_POLICIES.map(
    ([operationId, options]) => [
      operationId,
      dashboardOperationMetadata(operationId, options),
    ],
  )),
  "dashboard.notifications.fcm_token_cleanup": dashboardOperationMetadata(
    "dashboard.notifications.fcm_token_cleanup",
    {
      risk: "destructive",
      exposure: "excluded",
      batch: "forbidden",
      maxRequestBytes: 65_536,
      maximumResponseBytes: 8_192,
      exclusionReason:
        "Provider-delivery maintenance consumes raw FCM registration tokens and deactivates stale device rows; sends already deactivate provider-invalid tokens automatically, so this is not a merchant agent capability.",
    },
  ),
  "dashboard.home.legacy_combined": dashboardOperationMetadata(
    "dashboard.home.legacy_combined",
    {
      risk: "read",
      exposure: "excluded",
      maxRequestBytes: 16_384,
      maximumResponseBytes: 65_536,
      exclusionReason:
        "Superseded by the bounded dashboard.home.summary and dashboard.home.activity operations.",
    },
  ),
  "dashboard.settings.general_get": dashboardOperationMetadata(
    "dashboard.settings.general_get",
    {
      risk: "read",
      exposure: "excluded",
      maxRequestBytes: 16_384,
      maximumResponseBytes: 65_536,
      exclusionReason:
        "Legacy aggregate of independently managed header and footer documents; excluded until those documents are exposed as bounded semantic read projections.",
    },
  ),
  "dashboard.taxes.configuration_get": dashboardOperationMetadata(
    "dashboard.taxes.configuration_get",
    {
      risk: "read",
      exposure: "excluded",
      batch: "forbidden",
      exclusionReason:
        "Legacy aggregate can exceed the 65,536-byte structured-result ceiling because it returns every active jurisdiction; use dashboard.taxes.settings_get, dashboard.taxes.classes_list, dashboard.taxes.rates_list, and dashboard.taxes.jurisdictions_list.",
    },
  ),
  "dashboard.orders.shipment_status_sync": dashboardOperationMetadata(
    "dashboard.orders.shipment_status_sync",
    {
      risk: "write",
      exposure: "excluded",
      openWorld: true,
      exclusionReason:
        "Legacy duplicate with no active merchant caller; use dashboard.orders.shipment_refresh.",
    },
  ),
  ...reviewedEntries([
    "dashboard.orders.export",
    "dashboard.orders.payment_recovery_export",
  ], (operationId) => dashboardOperationMetadata(operationId, {
    risk: "read",
    exposure: "execute",
    batch: "forbidden",
    transport: "json",
    artifactOutput: {
      mediaTypes: ["text/csv"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 16 * 1024 * 1024,
      delivery: "authenticated-handle",
    },
  })),
  "dashboard.orders.invoice_print": dashboardOperationMetadata(
    "dashboard.orders.invoice_print",
    {
      risk: "read",
      exposure: "execute",
      batch: "forbidden",
      transport: "json",
      artifactOutput: {
        mediaTypes: ["text/html"],
        disposition: "attachment",
        filenamePolicy: "content-disposition",
        maxArtifactBytes: 65_536,
        delivery: "authenticated-handle",
      },
    },
  ),
  "dashboard.abandoned_checkouts.bulk_delete_legacy": dashboardOperationMetadata(
    "dashboard.abandoned_checkouts.bulk_delete_legacy",
    {
      risk: "destructive",
      exposure: "excluded",
      exclusionReason: "Legacy duplicate; use DELETE /admin/abandoned-checkouts.",
    },
  ),
  "dashboard.abandoned_checkouts.list": dashboardOperationMetadata(
    "dashboard.abandoned_checkouts.list",
    {
      risk: "read",
      exposure: "excluded",
      exclusionReason:
        "Browser detail projection contains buyer PII and serialized checkout state; use dashboard.abandoned_checkouts.summaries_list for bounded routine agent listing.",
    },
  ),
  "dashboard.shipments.get": dashboardOperationMetadata(
    "dashboard.shipments.get",
    {
      risk: "read",
      exposure: "excluded",
      exclusionReason: "Legacy duplicate; use dashboard.orders.shipment_get.",
    },
  ),
  "dashboard.shipments.delete": dashboardOperationMetadata(
    "dashboard.shipments.delete",
    {
      risk: "destructive",
      exposure: "excluded",
      openWorld: true,
      exclusionReason: "Legacy duplicate; use dashboard.orders.shipment_delete.",
    },
  ),
  "dashboard.shipments.status_sync": dashboardOperationMetadata(
    "dashboard.shipments.status_sync",
    {
      risk: "write",
      exposure: "excluded",
      openWorld: true,
      exclusionReason: "Legacy duplicate; use dashboard.orders.shipment_refresh.",
    },
  ),
  ...reviewedEntries([
    "dashboard.content.list",
    "dashboard.content.get",
  ], (operationId) => dashboardOperationMetadata(operationId, { risk: "read" })),
  ...reviewedEntries([
    "dashboard.content.create",
    "dashboard.content.bulk_publish",
    "dashboard.content.bulk_unpublish",
    "dashboard.content.bulk_restore",
    "dashboard.content.update",
    "dashboard.content.restore",
  ], (operationId) => dashboardOperationMetadata(operationId, {
    risk: "write",
    revision: operationId === "dashboard.content.create" ? "none" : "required",
    maximumResponseBytes: operationId.includes("bulk_") || operationId.endsWith(".trash") || operationId.endsWith(".restore")
      ? 16_384
      : 65_536,
  })),
  ...reviewedEntries([
    "dashboard.content.bulk_delete",
    "dashboard.content.trash",
    "dashboard.content.permanently_delete",
  ], (operationId) => dashboardOperationMetadata(operationId, {
    risk: "destructive",
    revision: "required",
    maximumResponseBytes: 16_384,
  })),
  ...reviewedEntries([
    "storefront.pages.list",
    "storefront.pages.get_by_slug",
    "storefront.pages.get_by_id",
    "storefront.articles.list",
    "storefront.articles.get_by_slug",
    "storefront.navigation.get",
    "storefront.navigation.placements_list",
    "storefront.navigation.menu_get",
    "storefront.navigation.items_list",
    "storefront.navigation.menu_get_by_id",
    "storefront.hero_sliders.list",
    "storefront.hero_sliders.get",
  ], (operationId) => storefrontReadMetadata(operationId)),
  ...reviewedEntries([
    "dashboard.media.list",
    "dashboard.media.upload_get",
    "dashboard.media_folders.list",
  ], (operationId) => dashboardOperationMetadata(operationId, {
    risk: "read",
    maximumResponseBytes: operationId === "dashboard.media.upload_get" ? 16_384 : 65_536,
  })),
  ...reviewedEntries([
    "dashboard.media.upload_initiate",
    "dashboard.media.import_url",
    "dashboard.media.upload_complete",
    "dashboard.media.upload_abort",
    "dashboard.media.update",
    "dashboard.media.restore",
    "dashboard.media.move",
    "dashboard.media_folders.create",
    "dashboard.media_folders.update",
  ], (operationId) => dashboardOperationMetadata(operationId, {
    risk: "write",
    openWorld: operationId === "dashboard.media.import_url",
    batch: operationId === "dashboard.media.import_url" ? "forbidden" : "sequential",
    revision: [
      "dashboard.media.update",
      "dashboard.media.restore",
      "dashboard.media.move",
      "dashboard.media_folders.update",
    ].includes(operationId) ? "required" : "none",
    maximumResponseBytes: [
      "dashboard.media.upload_initiate",
      "dashboard.media.upload_abort",
    ].includes(operationId) ? 16_384 : 65_536,
  })),
  ...reviewedEntries([
    "dashboard.media.trash",
    "dashboard.media.permanently_delete",
    "dashboard.media_folders.delete",
  ], (operationId) => dashboardOperationMetadata(operationId, {
    risk: "destructive",
    revision: "required",
    maximumResponseBytes: 16_384,
  })),
  "dashboard.media.upload_part": dashboardOperationMetadata(
    "dashboard.media.upload_part",
    {
      risk: "write",
      exposure: "execute",
      batch: "forbidden",
      transport: "octet-stream",
      maxRequestBytes: 5 * 1024 * 1024,
      maximumResponseBytes: 16_384,
      requiredClientAction: "direct-upload",
    },
  ),
  "dashboard.media.upload_reconcile": dashboardOperationMetadata(
    "dashboard.media.upload_reconcile",
    {
      risk: "write",
      exposure: "excluded",
      exclusionReason: "Internal expired-upload maintenance is not a merchant capability.",
    },
  ),
  ...reviewedEntries([
    "dashboard.navigation.resources_search",
    "dashboard.navigation.products_preview_count",
    "dashboard.navigation.menus_list",
    "dashboard.navigation.menus_get",
    "dashboard.navigation.items_list",
    "dashboard.navigation.items_search",
    "dashboard.navigation.items_get",
    "dashboard.navigation.items_move_options",
    "dashboard.navigation.publications_list",
    "dashboard.navigation.placements_manifest",
    "dashboard.navigation.placements_list",
  ], (operationId) => dashboardOperationMetadata(operationId, {
    risk: "read",
    maximumResponseBytes: operationId === "dashboard.navigation.products_preview_count"
      ? 16_384
      : 65_536,
  })),
  ...reviewedEntries([
    "dashboard.navigation.menus_create",
    "dashboard.navigation.menus_update",
    "dashboard.navigation.menus_restore",
    "dashboard.navigation.items_create",
    "dashboard.navigation.items_update",
    "dashboard.navigation.items_move",
    "dashboard.navigation.menus_publish",
    "dashboard.navigation.menus_rollback",
    "dashboard.navigation.placements_save",
  ], (operationId) => dashboardOperationMetadata(operationId, {
    risk: "write",
    revision: operationId === "dashboard.navigation.menus_create" ? "none" : "required",
  })),
  "dashboard.navigation.menus_trash": dashboardOperationMetadata(
    "dashboard.navigation.menus_trash",
    { risk: "destructive", revision: "required", maximumResponseBytes: 16_384 },
  ),
  "dashboard.navigation.items_delete": dashboardOperationMetadata(
    "dashboard.navigation.items_delete",
    { risk: "destructive", revision: "required", maximumResponseBytes: 16_384 },
  ),
  "dashboard.navigation.legacy_items_list": dashboardOperationMetadata(
    "dashboard.navigation.legacy_items_list",
    {
      risk: "read",
      exposure: "excluded",
      exclusionReason: "Superseded by normalized reusable-menu and item operations.",
    },
  ),
  "dashboard.navigation.authority_shadow": dashboardOperationMetadata(
    "dashboard.navigation.authority_shadow",
    {
      risk: "read",
      exposure: "excluded",
      exclusionReason: "Internal normalized-authority migration parity report.",
    },
  ),
  ...reviewedEntries([
    "dashboard.hero_sliders.list",
    "dashboard.hero_sliders.get",
    "dashboard.theme.get",
    "dashboard.theme.workspace_get",
    "dashboard.theme.versions_list",
  ], (operationId) => dashboardOperationMetadata(operationId, { risk: "read" })),
  ...reviewedEntries([
    "dashboard.hero_sliders.create",
    "dashboard.hero_sliders.update",
    "dashboard.theme.draft_save",
    "dashboard.theme.draft_rebase",
    "dashboard.theme.publish",
    "dashboard.theme.rollback",
  ], (operationId) => dashboardOperationMetadata(operationId, {
    risk: "write",
    revision: operationId === "dashboard.hero_sliders.create" ? "none" : "required",
  })),
  "dashboard.hero_sliders.trash": dashboardOperationMetadata(
    "dashboard.hero_sliders.trash",
    { risk: "destructive", revision: "required", maximumResponseBytes: 16_384 },
  ),
  "dashboard.theme.save_legacy": dashboardOperationMetadata(
    "dashboard.theme.save_legacy",
    {
      risk: "write",
      exposure: "excluded",
      exclusionReason:
        "Superseded by durable draft, preview, publish, version, and rollback workflow.",
    },
  ),
  "dashboard.theme.preview_session_create": dashboardOperationMetadata(
    "dashboard.theme.preview_session_create",
    {
      risk: "read",
      exposure: "continuation",
      revision: "none",
      batch: "forbidden",
      transport: "continuation",
      maximumResponseBytes: 8_192,
      maxRequestBytes: 65_536,
      sensitiveOutput: true,
      continuationOutput: {
        method: "POST",
        urlJsonPointer: "/data/continuation/url",
        fieldsJsonPointer: "/data/continuation/fields",
        sensitiveFields: ["continuationCode"],
      },
    },
  ),
};

function normalizePath(path: string): string {
  const withoutBase = path.replace(/^\/api\/v1(?=\/|$)/, "");
  return withoutBase === "" ? "/" : withoutBase;
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isOperation(value: unknown): value is OpenApiOperation {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function operationAction(method: string, path: string): string {
  const segments = path.split("/").filter(Boolean);
  const terminal = segments.at(-1) ?? "root";
  const terminalIsParameter = /^\{[^}]+\}$/.test(terminal);
  if (method === "get") return terminalIsParameter ? "get" : `get_${terminal}`;
  if (method === "post") return terminalIsParameter ? "create" : terminal;
  if (method === "put") return terminalIsParameter ? "replace" : `replace_${terminal}`;
  if (method === "patch") return terminalIsParameter ? "update" : terminal;
  if (method === "delete") return terminalIsParameter ? "delete" : `delete_${terminal}`;
  return `${method}_${terminal}`;
}

function agentSurface(path: string): AgentOperationMetadata["surface"] {
  if (
    path === "/admin" ||
    path.startsWith("/admin/") ||
    path === "/cache" ||
    path.startsWith("/cache/")
  ) {
    return "dashboard";
  }
  if (
    path === "/agent-artifacts" ||
    path.startsWith("/agent-artifacts/") ||
    path === "/storefront/theme-preview/resolve" ||
    path === "/storefront/agent-continuations" ||
    path.startsWith("/storefront/agent-continuations/") ||
    path.startsWith("/agent-auth") ||
    path.startsWith("/auth") ||
    path === "/setup"
  ) {
    return "system";
  }
  return "storefront";
}

function generatedOperationId(path: string, method: string): string {
  const surface = agentSurface(path);
  const withoutSurface = surface === "dashboard"
    ? path.replace(/^\/admin(?=\/|$)/, "")
    : path;
  const segments = withoutSurface
    .split("/")
    .filter(Boolean)
    .filter((segment) => !/^\{[^}]+\}$/.test(segment));
  const resource = (segments.length > 0 ? segments : ["root"])
    .map((segment) => segment
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, ""))
    .filter(Boolean)
    .join("_");
  const action = operationAction(method, path)
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "run";
  const candidate = `${surface}.${resource}.${action}`.toLowerCase();
  if (!AGENT_OPERATION_ID_PATTERN.test(candidate)) {
    throw new Error(`Cannot derive stable operationId for ${method.toUpperCase()} ${path}.`);
  }
  return candidate;
}

function excludedMetadata(path: string, method: string): AgentOperationMetadata {
  const surface = agentSurface(path);
  const internalStorefrontContinuation =
    path === "/storefront/agent-continuations" ||
    path.startsWith("/storefront/agent-continuations/");
  return {
    surface,
    exposure: "excluded",
    principals: internalStorefrontContinuation
      ? ["internal"]
      : surface === "storefront"
        ? ["visitor"]
        : ["admin"],
    risk: method === "get" || method === "head" ? "read" : "write",
    openWorld: false,
    idempotency: "none",
    revision: "none",
    batch: "forbidden",
    transport: "json",
    maximumResponseBytes: 65_536,
    maxRequestBytes: 1024 * 1024,
    sensitiveOutput: false,
    oneTimeSecretOutput: false,
    exclusionReason: internalStorefrontContinuation
      ? "Internal service-JWT browser continuation bridge; use the protected context continuation operations."
      : "Pending operation-specific parity, authority, and output review.",
  };
}

function concreteRbacPath(path: string): string {
  return `/api/v1${path}`.replace(/\{[^}]+\}/g, "contract_parameter");
}

function operationRbac(path: string, method: string): AgentOperationRbac {
  if (path === "/agent-artifacts" || path.startsWith("/agent-artifacts/")) {
    return { type: "agentGrant" };
  }
  if (path === "/storefront/theme-preview/resolve") {
    return { type: "unmapped" };
  }
  if (
    path === "/storefront/agent-continuations" ||
    path.startsWith("/storefront/agent-continuations/")
  ) {
    return { type: "unmapped" };
  }
  if (path === "/agent-auth/revoke") {
    return { type: "agentGrant" };
  }
  if (
    path === "/storefront/agent-contexts" ||
    path.startsWith("/storefront/agent-contexts/")
  ) {
    return { type: "agentGrant" };
  }
  const dashboardPath =
    path === "/admin" ||
    path.startsWith("/admin/") ||
    path === "/cache" ||
    path.startsWith("/cache/");
  if (!dashboardPath) {
    return { type: "public" };
  }
  const routePermission = getRoutePermission(
    concreteRbacPath(path),
    method.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  );
  if (!routePermission) return { type: "unmapped" };
  if (routePermission.allowAnyAdmin) return { type: "allowAnyAdmin" };
  if (routePermission.permission) {
    return { type: "permission", permission: routePermission.permission };
  }
  if (routePermission.anyOf) {
    return { type: "anyOf", permissions: [...routePermission.anyOf].sort() };
  }
  if (routePermission.allOf) {
    return { type: "allOf", permissions: [...routePermission.allOf].sort() };
  }
  return { type: "unmapped" };
}

function assertRequiredMutationBody(operation: OpenApiOperation, operationId: string): void {
  const metadata = operation["x-scalius-agent"];
  if (
    metadata?.exposure !== "execute" ||
    metadata.risk === "read" ||
    !("requestBody" in operation)
  ) {
    return;
  }
  const requestBody = operation.requestBody;
  if (!isOperation(requestBody) || requestBody.required !== true) {
    throw new Error(`${operationId} has a request body that is not marked required.`);
  }
}

function isScannerEndpoint(path: string, method: string): boolean {
  return (
    (method === "get" && path === "/admin/inventory/scanner/lookup") ||
    (method === "post" && path === "/admin/inventory/stock-adjust") ||
    (method === "post" && path === "/admin/inventory/stock-set")
  );
}

function isCustomerSessionEndpoint(path: string): boolean {
  return (
    path === "/customer-auth/me" ||
    path === "/customer-auth/logout" ||
    path === "/customer-auth/profile" ||
    path.startsWith("/customer-auth/orders")
  );
}

function securityForOperation(path: string, method: string): OpenApiSecurityRequirement[] | null {
  if (isScannerEndpoint(path, method)) return SCANNER_SECURITY;
  if (path === "/auth/token") return API_TOKEN_SECURITY;
  if (path === "/auth/me" || path === "/auth/revoke" || path === "/auth/token-stats") {
    return BEARER_SECURITY;
  }
  if (isCustomerSessionEndpoint(path)) return CUSTOMER_SECURITY;
  if (path === "/agent-artifacts" || path.startsWith("/agent-artifacts/")) {
    return AGENT_SECURITY;
  }
  if (
    path === "/storefront/agent-continuations" ||
    path.startsWith("/storefront/agent-continuations/")
  ) {
    return BEARER_SECURITY;
  }
  if (path === "/agent-auth/revoke") return AGENT_SECURITY;
  // The private preview token is the request-body proof; it is not an HTTP
  // authentication scheme and therefore has an explicit empty requirement.
  if (path === "/storefront/theme-preview/resolve") return [];
  if (
    path === "/storefront/agent-contexts" ||
    path.startsWith("/storefront/agent-contexts/")
  ) {
    return AGENT_SECURITY;
  }
  if (path === "/admin" || path.startsWith("/admin/")) return ADMIN_SECURITY;
  if (path === "/cache" || path.startsWith("/cache/")) return ADMIN_SECURITY;
  return null;
}

function documentedContractStatuses(path: string, method: string): Array<keyof typeof CONTRACT_ERROR_RESPONSES> {
  const statuses: Array<keyof typeof CONTRACT_ERROR_RESPONSES> = [];

  if (method === "post" && path === "/setup") statuses.push("409", "503");
  if (method === "post" && path === "/admin/rbac/roles") statuses.push("409");
  if (method === "delete" && path === "/admin/rbac/roles/{id}") statuses.push("409");
  if (method === "post" && path === "/admin/rbac/user-roles") statuses.push("409");
  if (
    method === "post" &&
    (path === "/payment/stripe/intent" || /^\/payment\/[^/]+\/session$/.test(path))
  ) {
    statuses.push("409", "503");
  }

  return statuses;
}

function applySecuritySchemes(spec: OpenApiDocument): void {
  spec.components ??= {};
  spec.components.securitySchemes = {
    ...(spec.components.securitySchemes ?? {}),
    ...SECURITY_SCHEMES,
  };
}

function applyOperationContract(spec: OpenApiDocument): void {
  if (!spec.paths) return;

  for (const [rawPath, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    const path = normalizePath(rawPath);
    for (const [rawMethod, operation] of Object.entries(pathItem)) {
      const method = rawMethod.toLowerCase();
      if (!HTTP_METHODS.has(method) || !isOperation(operation)) continue;

      const security = securityForOperation(path, method);
      if (security && !hasOwn(operation, "security")) {
        operation.security = security;
      }

      const statuses = documentedContractStatuses(path, method);
      if (statuses.length > 0) {
        operation.responses ??= {};
        for (const status of statuses) {
          operation.responses[status] ??= CONTRACT_ERROR_RESPONSES[status];
        }
      }

      const operationKey = `${method.toUpperCase()} ${path}`;
      const derivedOperationId =
        operation.operationId ?? generatedOperationId(path, method);
      const pathReviewed = REVIEWED_AGENT_OPERATIONS[operationKey];
      const idReviewed = REVIEWED_AGENT_OPERATIONS_BY_ID[derivedOperationId];
      const reviewed = pathReviewed ?? idReviewed;
      if (
        reviewed &&
        operation.operationId !== undefined &&
        operation.operationId !== reviewed.operationId
      ) {
        throw new Error(
          `${operationKey} declares operationId ${operation.operationId}; expected ${reviewed.operationId}.`,
        );
      }
      if (
        (reviewed?.metadata.exposure === "execute" ||
          reviewed?.metadata.exposure === "continuation") &&
        reviewed.metadata.surface === "dashboard"
      ) {
        operation.security = isScannerEndpoint(path, method)
          ? SCANNER_ADMIN_OR_AGENT_SECURITY
          : ADMIN_OR_AGENT_SECURITY;
      }
      operation.operationId ??= reviewed?.operationId ?? derivedOperationId;
      operation["x-scalius-agent"] ??=
        reviewed?.metadata ?? excludedMetadata(path, method);
      operation["x-scalius-rbac"] ??= operationRbac(path, method);
      // OpenAPI has no root security requirement. Make intentional public
      // access explicit instead of relying on the implicit empty default.
      // Proof-bearing receipt/payment endpoints still document their proof
      // headers and bodies independently; they do not use an auth scheme.
      if (!hasOwn(operation, "security") && operation["x-scalius-rbac"]?.type === "public") {
        operation.security = [];
      }
      if (
        reviewed?.metadata.exposure === "execute" &&
        reviewed.metadata.risk !== "read" &&
        "requestBody" in operation &&
        isOperation(operation.requestBody)
      ) {
        // @hono/zod-openapi currently omits this OpenAPI flag unless each
        // route repeats it. Executable agent mutations make the contract
        // explicit at the single finalization seam.
        operation.requestBody.required ??= true;
      }
      assertRequiredMutationBody(operation, operation.operationId);
    }
  }

  // This validates identity uniqueness, metadata shape, surface prefixes, and
  // RBAC structure on every finalized contract. The returned catalog is built
  // separately so OpenAPI serving never depends on generated runtime state.
  buildAgentOperationManifest(spec);
}

/**
 * Hono's OpenAPI 3.0 serializer represents unconstrained Zod values as the
 * schema fragment `{ nullable: true }`. `nullable` modifies a declared type in
 * OpenAPI 3.0 and is not a schema by itself, so validators correctly reject
 * that fragment. An empty schema is the accurate OpenAPI 3.0 representation
 * of the same unconstrained value (including null).
 */
function normalizeUnconstrainedOpenApiSchemas(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) normalizeUnconstrainedOpenApiSchemas(item);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length === 1 &&
    record.nullable === true
  ) {
    delete record.nullable;
    return;
  }
  for (const item of Object.values(record)) {
    normalizeUnconstrainedOpenApiSchemas(item);
  }
}

export function finalizeOpenApiContract<T extends { components?: unknown; paths?: unknown }>(spec: T): T {
  const document = spec as OpenApiDocument;
  applySecuritySchemes(document);
  applyOperationContract(document);
  normalizeUnconstrainedOpenApiSchemas(document);
  return spec;
}
