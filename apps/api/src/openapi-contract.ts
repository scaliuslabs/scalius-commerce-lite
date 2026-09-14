import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import {
  buildAgentWorkflowCatalog,
  type AgentWorkflowCatalog,
} from "./agent-access/workflows";
import {
  AGENT_OPERATION_ID_PATTERN,
  buildAgentOperationManifest,
  type AgentOperationMetadata,
  type AgentOperationRbac,
} from "./openapi/agent-operation-manifest";
import {
  operationMetadata,
  registryEntry,
} from "./openapi/operation-registry";

/**
 * Finalizes the `/api/v1` OpenAPI document.
 *
 * This module holds no operation policy. Every per-operation fact is derived:
 * agent metadata expands from the single `openapi/operation-registry.ts` table,
 * RBAC from `getRoutePermission()`, and identity from the route itself. What
 * stays here is the document-level seam: security schemes, the shared error
 * responses, the security requirement each route family uses, operation-ID
 * derivation for routes that do not declare one, and the fail-closed fallback
 * for a route that has no registry row yet.
 */

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
  "x-scalius-workflows"?: AgentWorkflowCatalog;
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

/**
 * Fail-closed metadata for a route with no `operation-registry.ts` row. It is
 * deliberately generic so `assertNoGenericPendingAgentOperations()` rejects the
 * generated manifest until the route is registered.
 */
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

      const operationId = operation.operationId ?? generatedOperationId(path, method);
      const entry = registryEntry(operationId);
      const metadata = entry
        ? operationMetadata(operationId, method, entry)
        : excludedMetadata(path, method);
      if (
        (metadata.exposure === "execute" || metadata.exposure === "continuation") &&
        metadata.surface === "dashboard"
      ) {
        operation.security = isScannerEndpoint(path, method)
          ? SCANNER_ADMIN_OR_AGENT_SECURITY
          : ADMIN_OR_AGENT_SECURITY;
      }
      operation.operationId ??= operationId;
      operation["x-scalius-agent"] ??= metadata;
      operation["x-scalius-rbac"] ??= operationRbac(path, method);
      // OpenAPI has no root security requirement. Make intentional public
      // access explicit instead of relying on the implicit empty default.
      // Proof-bearing receipt/payment endpoints still document their proof
      // headers and bodies independently; they do not use an auth scheme.
      if (!hasOwn(operation, "security") && operation["x-scalius-rbac"]?.type === "public") {
        operation.security = [];
      }
      if (
        metadata.exposure === "execute" &&
        metadata.risk !== "read" &&
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
  document["x-scalius-workflows"] = buildAgentWorkflowCatalog(
    buildAgentOperationManifest(document),
  );
  return spec;
}
