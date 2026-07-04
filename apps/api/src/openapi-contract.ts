type OpenApiSecurityRequirement = Record<string, string[]>;

type OpenApiOperation = {
  security?: OpenApiSecurityRequirement[];
  responses?: Record<string, unknown>;
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

function normalizePath(path: string): string {
  const withoutBase = path.replace(/^\/api\/v1(?=\/|$)/, "");
  return withoutBase === "" ? "/" : withoutBase;
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isOperation(value: unknown): value is OpenApiOperation {
  return value !== null && typeof value === "object";
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
    }
  }
}

export function finalizeOpenApiContract<T extends { components?: unknown; paths?: unknown }>(spec: T): T {
  const document = spec as OpenApiDocument;
  applySecuritySchemes(document);
  applyOperationContract(document);
  return spec;
}
