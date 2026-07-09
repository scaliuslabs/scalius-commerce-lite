import {
  getRoutePermission,
} from "@scalius/core/auth/rbac/route-permissions";
import {
  ADMIN_OPENAPI_OPERATION_COUNT,
  ADMIN_OPENAPI_PATH_INVENTORY,
  type AdminHttpMethod,
} from "./admin-operation-inventory";

export type AdminCapabilityImplementation =
  | "typed-command"
  | "browser-adapter"
  | "secure-manual";

export type AdminRisk = "R0" | "R1" | "R2" | "R3";

export type AdminAuthorization =
  | { readonly kind: "permission"; readonly permission: string }
  | { readonly kind: "any-of"; readonly permissions: readonly string[] }
  | { readonly kind: "all-of"; readonly permissions: readonly string[] }
  | { readonly kind: "any-admin" };

export type AdminIdempotencyEvidence =
  | { readonly kind: "not-applicable" }
  | { readonly kind: "unproven" }
  | { readonly kind: "inherent"; readonly evidenceId: string }
  | {
      readonly kind: "adapter";
      readonly adapterName: string;
      readonly implemented: boolean;
      readonly evidenceId: string | null;
    };

export interface AdminCommandDescriptor {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly operationKey: string;
  readonly surface: "admin";
  readonly method: AdminHttpMethod;
  readonly pathTemplate: string;
  readonly authorization: AdminAuthorization;
  readonly implementation: AdminCapabilityImplementation;
  readonly flags: {
    readonly readOnly: boolean;
    readonly reversible: boolean;
    readonly destructive: boolean;
    readonly financial: boolean;
    readonly external: boolean;
    readonly freshAuth: boolean;
    readonly bulk: boolean;
  };
  readonly risk: AdminRisk;
  readonly confirmation:
    | "none"
    | "signed-explicit"
    | "signed-explicit-fresh-auth"
    | "secure-control";
  readonly idempotency: {
    readonly policy: "not-applicable" | "required";
    readonly evidence: AdminIdempotencyEvidence;
  };
  readonly preview: {
    readonly required: boolean;
    readonly supported: boolean;
    readonly dryRunSupported: boolean;
    readonly evidenceId: string | null;
  };
  readonly execution: {
    readonly enabled: boolean;
    readonly readiness:
      | "read-only-eligible"
      | "requires-controls"
      | "secure-manual";
    readonly blockers: readonly (
      | "execution-adapter"
      | "authoritative-preview"
      | "idempotency-evidence"
      | "secure-input-control"
    )[];
  };
  readonly secretHandling:
    | "none"
    | "redacted-result"
    | "secure-input"
    | "secure-input-and-redacted-result";
  readonly input: {
    readonly contentType: "none" | "application/json" | "multipart/form-data";
    readonly maxBodyBytes: number;
    readonly maxQueryChars: number;
    readonly maxPathParameterChars: number;
    readonly maxItems: number;
    readonly maxStringChars: number;
  };
  readonly result: {
    readonly maxBytes: number;
    readonly maxItems: number;
    readonly redactionRequired: boolean;
  };
  readonly auditCategory:
    | "read"
    | "mutation"
    | "destructive"
    | "financial"
    | "security"
    | "external";
  readonly concurrency:
    | "not-applicable"
    | "optimistic-version-required"
    | "serial-and-reconcile";
}

interface RoutePermissionShape {
  readonly permission?: string;
  readonly anyOf?: readonly string[];
  readonly allOf?: readonly string[];
  readonly allowAnyAdmin?: boolean;
}

const READ_ONLY_POST_OPERATIONS = new Set([
  "POST /api/v1/admin/ai-context/batch-details",
  "POST /api/v1/admin/ai/chat",
  "POST /api/v1/admin/customers/mcp-search",
  "POST /api/v1/admin/fraud-checker/lookup",
  "POST /api/v1/admin/fraud-checker/{id}/test",
  "POST /api/v1/admin/settings/delivery-providers/create-test",
  "POST /api/v1/admin/settings/delivery-providers/{id}",
  "POST /api/v1/admin/taxes/preview",
]);

const CREDENTIAL_SETTING_SEGMENTS = new Set([
  "auth",
  "delivery-providers",
  "email",
  "firebase",
  "meta-conversions",
  "polar",
  "sms",
  "sslcommerz",
  "stripe",
  "widget-ai",
]);

const REVERSIBLE_BULK_ACTIONS = /\/(?:bulk-(?:activate|deactivate|publish|restore|unpublish))$/;
const SOFT_DELETE_RESOURCE = /^\/api\/v1\/admin\/(?:attributes|categories|collections|customers|discounts|orders|pages|products|widgets)\/\{[^}]+\}$/;
const SOFT_DELETE_SETTING_RESOURCE = /^\/api\/v1\/admin\/settings\/(?:delivery-locations|hero-sliders|shipping-methods)\/\{[^}]+\}$/;
const SOFT_DELETE_OPERATIONS = new Set([
  "DELETE /api/v1/admin/settings/delivery-locations",
  "DELETE /api/v1/admin/taxes/classes/{id}",
  "DELETE /api/v1/admin/taxes/rates/{id}",
  "PATCH /api/v1/admin/settings/checkout-languages/{id}",
]);
const IMPLICIT_BULK_OPERATIONS = new Set([
  "DELETE /api/v1/admin/abandoned-checkouts",
  "DELETE /api/v1/admin/settings/delivery-locations",
  "DELETE /api/v1/admin/settings/meta-conversions/logs",
  "POST /api/v1/admin/settings/meta-conversions/logs",
]);

function operationKey(method: AdminHttpMethod, pathTemplate: string): string {
  return `${method} ${pathTemplate}`;
}

function samplePath(pathTemplate: string): string {
  return pathTemplate
    .replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, "registry-id")
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, "registry-id");
}

function normalizeAuthorization(
  routePermission: RoutePermissionShape | null,
  key: string,
): AdminAuthorization {
  if (!routePermission) {
    throw new Error(`Admin command registry has no ROUTE_PERMISSIONS entry for ${key}`);
  }

  const modes = [
    typeof routePermission.permission === "string",
    Array.isArray(routePermission.anyOf) && routePermission.anyOf.length > 0,
    Array.isArray(routePermission.allOf) && routePermission.allOf.length > 0,
    routePermission.allowAnyAdmin === true,
  ].filter(Boolean).length;

  if (modes !== 1) {
    throw new Error(`Admin command registry has ambiguous ROUTE_PERMISSIONS for ${key}`);
  }

  if (routePermission.permission) {
    return { kind: "permission", permission: routePermission.permission };
  }
  if (routePermission.anyOf?.length) {
    return { kind: "any-of", permissions: [...routePermission.anyOf].sort() };
  }
  if (routePermission.allOf?.length) {
    return { kind: "all-of", permissions: [...routePermission.allOf].sort() };
  }
  return { kind: "any-admin" };
}

export function isSafeAdminPathTemplate(pathTemplate: string): boolean {
  if (
    pathTemplate.length > 320 ||
    !pathTemplate.startsWith("/api/v1/admin/") ||
    /[?#\\%]/.test(pathTemplate) ||
    pathTemplate.includes("://")
  ) {
    return false;
  }

  return pathTemplate.split("/").slice(1).every((segment) => {
    if (!segment || segment === "." || segment === "..") return false;
    return (
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) ||
      /^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(segment) ||
      /^:[A-Za-z][A-Za-z0-9_]*$/.test(segment)
    );
  });
}

function capabilityId(method: AdminHttpMethod, pathTemplate: string): string {
  const pathId = pathTemplate
    .slice("/api/v1/admin/".length)
    .split("/")
    .map((segment) => {
      const parameter = segment.match(/^\{([^}]+)\}$/)?.[1] ?? segment.match(/^:(.+)$/)?.[1];
      return parameter
        ? `by-${parameter.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`
        : segment.toLowerCase();
    })
    .join(".");
  return `admin.api.${method.toLowerCase()}.${pathId}`;
}

function settingSegment(pathTemplate: string): string | null {
  return pathTemplate.match(/^\/api\/v1\/admin\/settings\/([^/{:]+)/)?.[1] ?? null;
}

function isCredentialPath(pathTemplate: string): boolean {
  const segment = settingSegment(pathTemplate);
  return (
    (segment !== null && CREDENTIAL_SETTING_SEGMENTS.has(segment)) ||
    pathTemplate.startsWith("/api/v1/admin/auth/2fa/") ||
    pathTemplate === "/api/v1/admin/auth/change-password" ||
    pathTemplate.startsWith("/api/v1/admin/fraud-checker")
  );
}

function isCredentialOrSecurityPath(pathTemplate: string): boolean {
  return (isCredentialPath(pathTemplate) &&
      pathTemplate !== "/api/v1/admin/settings/meta-conversions/logs") ||
    pathTemplate === "/api/v1/admin/settings/security";
}

function deriveFlags(method: AdminHttpMethod, pathTemplate: string) {
  const key = operationKey(method, pathTemplate);
  const readOnly = method === "GET" || READ_ONLY_POST_OPERATIONS.has(key);
  const bulk = /\/bulk-|\/all$/.test(pathTemplate) || IMPLICIT_BULK_OPERATIONS.has(key);
  const permanent = /\/permanent(?:-delete)?$|\/cleanup$/.test(pathTemplate);
  const softDelete = SOFT_DELETE_OPERATIONS.has(key) || (
    method === "DELETE" && (
      SOFT_DELETE_RESOURCE.test(pathTemplate) || SOFT_DELETE_SETTING_RESOURCE.test(pathTemplate)
    )
  );
  const destructive = !readOnly && (
    method === "DELETE" ||
    permanent ||
    softDelete ||
    IMPLICIT_BULK_OPERATIONS.has(key) ||
    /\/bulk-delete$|\/stock-set$|\/refund$|\/return$/.test(pathTemplate)
  );
  const financial = !readOnly && (
    pathTemplate === "/api/v1/admin/orders" ||
    pathTemplate.startsWith("/api/v1/admin/taxes") ||
    /\/orders\/[^/]+\/(?:cod|payment-recovery-link|refund|return|status)$/.test(samplePath(pathTemplate)) ||
    /^\/api\/v1\/admin\/settings\/(?:payment-methods|polar|sslcommerz|stripe)(?:\/|$)/.test(pathTemplate)
  );
  const externalRead = readOnly && (
    key === "POST /api/v1/admin/ai/chat" ||
    key === "POST /api/v1/admin/fraud-checker/lookup" ||
    key === "POST /api/v1/admin/fraud-checker/{id}/test" ||
    key === "POST /api/v1/admin/settings/delivery-providers/create-test" ||
    key === "POST /api/v1/admin/settings/delivery-providers/{id}"
  );
  const external = externalRead || (!readOnly && (
    /\/ai\/(?:generate|generate-staged)$/.test(pathTemplate) ||
    pathTemplate.startsWith("/api/v1/admin/analytics") ||
    pathTemplate.startsWith("/api/v1/admin/fcm-token") ||
    pathTemplate.startsWith("/api/v1/admin/fraud-checker") ||
    pathTemplate === "/api/v1/admin/media/upload" ||
    /\/notifications\//.test(pathTemplate) ||
    /\/shipments(?:\/|$)|\/fulfill$/.test(pathTemplate) ||
    (/^\/api\/v1\/admin\/settings\/(?:delivery-providers|email|firebase|meta-conversions|polar|sms|sslcommerz|stripe|widget-ai)(?:\/|$)/.test(pathTemplate) &&
      pathTemplate !== "/api/v1/admin/settings/meta-conversions/logs")
  ));
  const securityMutation = !readOnly && (
    pathTemplate.startsWith("/api/v1/admin/rbac/") ||
    pathTemplate.startsWith("/api/v1/admin/auth/") ||
    isCredentialOrSecurityPath(pathTemplate) ||
    pathTemplate.startsWith("/api/v1/admin/analytics")
  );
  const sensitiveDomainMutation = !readOnly && (
    pathTemplate.startsWith("/api/v1/admin/inventory/") ||
    pathTemplate.startsWith("/api/v1/admin/orders") ||
    pathTemplate.startsWith("/api/v1/admin/shipments")
  );
  const freshAuth = !readOnly && (
    securityMutation ||
    financial ||
    permanent ||
    pathTemplate.endsWith("/all") ||
    (bulk && destructive) ||
    /\/bulk-delete$|\/stock-(?:adjust|set)$|\/adjust$/.test(pathTemplate)
  );

  const reversible = !readOnly && (
    softDelete ||
    REVERSIBLE_BULK_ACTIONS.test(pathTemplate) ||
    /\/restore$|\/toggle(?:-status)?$/.test(pathTemplate) ||
    (!destructive && !financial && !external && !securityMutation && !sensitiveDomainMutation)
  );

  return {
    readOnly,
    reversible,
    destructive,
    financial,
    external,
    freshAuth,
    bulk,
  } as const;
}

function deriveImplementation(
  method: AdminHttpMethod,
  pathTemplate: string,
  readOnly: boolean,
): AdminCapabilityImplementation {
  if (pathTemplate === "/api/v1/admin/fcm-token") return "browser-adapter";
  if (!readOnly && (
    isCredentialOrSecurityPath(pathTemplate) ||
    pathTemplate.startsWith("/api/v1/admin/rbac/") ||
    pathTemplate.startsWith("/api/v1/admin/analytics")
  )) {
    return "secure-manual";
  }
  if (method === "POST" && pathTemplate === "/api/v1/admin/ai/chat") {
    return "browser-adapter";
  }
  return "typed-command";
}

function deriveSecretHandling(
  method: AdminHttpMethod,
  pathTemplate: string,
): AdminCommandDescriptor["secretHandling"] {
  const metaConversionLogs = pathTemplate === "/api/v1/admin/settings/meta-conversions/logs";
  if (metaConversionLogs) return method === "GET" ? "redacted-result" : "none";
  const secretPath = isCredentialPath(pathTemplate);
  const redactedRecoveryResult = method === "POST" && pathTemplate.endsWith("/payment-recovery-link");
  if (secretPath && method === "GET") return "redacted-result";
  if (secretPath && method !== "GET") return "secure-input-and-redacted-result";
  if (redactedRecoveryResult) return "redacted-result";
  return "none";
}

function deriveBounds(
  method: AdminHttpMethod,
  pathTemplate: string,
  bulk: boolean,
) {
  const upload = pathTemplate === "/api/v1/admin/media/upload";
  const aiPayload = pathTemplate.startsWith("/api/v1/admin/ai/") ||
    pathTemplate.startsWith("/api/v1/admin/widget-generation-runs");
  const exportResult = pathTemplate.endsWith("/export");

  return {
    input: {
      contentType: method === "GET"
        ? "none" as const
        : upload
          ? "multipart/form-data" as const
          : "application/json" as const,
      maxBodyBytes: method === "GET" ? 0 : upload ? 64 * 1024 * 1024 : aiPayload ? 2 * 1024 * 1024 : 1024 * 1024,
      maxQueryChars: 16_384,
      maxPathParameterChars: 256,
      maxItems: upload ? 20 : bulk ? 500 : aiPayload ? 50 : 1,
      maxStringChars: aiPayload ? 250_000 : 32_768,
    },
    result: {
      maxBytes: exportResult ? 16 * 1024 * 1024 : 2 * 1024 * 1024,
      maxItems: exportResult ? 10_000 : 500,
    },
  };
}

function deriveRisk(flags: ReturnType<typeof deriveFlags>): AdminRisk {
  if (flags.readOnly) return "R0";
  if (
    flags.destructive || flags.financial || flags.external ||
    flags.freshAuth || flags.bulk
  ) {
    return "R3";
  }
  return "R2";
}

function buildDescriptor(
  method: AdminHttpMethod,
  pathTemplate: string,
): AdminCommandDescriptor {
  if (!isSafeAdminPathTemplate(pathTemplate)) {
    throw new Error(`Unsafe Admin OpenAPI path template: ${pathTemplate}`);
  }

  const key = operationKey(method, pathTemplate);
  const authorization = normalizeAuthorization(
    getRoutePermission(samplePath(pathTemplate), method) as RoutePermissionShape | null,
    key,
  );
  const flags = deriveFlags(method, pathTemplate);
  const risk = deriveRisk(flags);
  const implementation = deriveImplementation(method, pathTemplate, flags.readOnly);
  const secretHandling = deriveSecretHandling(method, pathTemplate);
  const bounds = deriveBounds(method, pathTemplate, flags.bulk);
  const secureManual = implementation === "secure-manual";

  return {
    schemaVersion: 1,
    id: capabilityId(method, pathTemplate),
    operationKey: key,
    surface: "admin",
    method,
    pathTemplate,
    authorization,
    implementation,
    flags,
    risk,
    confirmation: flags.readOnly
      ? "none"
      : secureManual
        ? "secure-control"
        : flags.freshAuth
          ? "signed-explicit-fresh-auth"
          : "signed-explicit",
    idempotency: flags.readOnly
      ? { policy: "not-applicable", evidence: { kind: "not-applicable" } }
      : { policy: "required", evidence: { kind: "unproven" } },
    preview: {
      required: !flags.readOnly,
      supported: false,
      dryRunSupported: false,
      evidenceId: null,
    },
    execution: flags.readOnly
      ? {
          enabled: false,
          readiness: "read-only-eligible",
          blockers: ["execution-adapter"],
        }
      : secureManual
        ? {
            enabled: false,
            readiness: "secure-manual",
            blockers: ["secure-input-control", "authoritative-preview", "idempotency-evidence", "execution-adapter"],
          }
        : {
            enabled: false,
            readiness: "requires-controls",
            blockers: ["authoritative-preview", "idempotency-evidence", "execution-adapter"],
          },
    secretHandling,
    input: bounds.input,
    result: {
      ...bounds.result,
      redactionRequired: secretHandling === "redacted-result" ||
        secretHandling === "secure-input-and-redacted-result",
    },
    auditCategory: flags.readOnly
      ? "read"
      : pathTemplate.startsWith("/api/v1/admin/rbac/") ||
          pathTemplate.startsWith("/api/v1/admin/auth/") ||
          isCredentialOrSecurityPath(pathTemplate)
        ? "security"
        : flags.financial
          ? "financial"
          : flags.external
            ? "external"
            : flags.destructive
              ? "destructive"
              : "mutation",
    concurrency: flags.readOnly
      ? "not-applicable"
      : flags.external || flags.financial
        ? "serial-and-reconcile"
        : "optimistic-version-required",
  };
}

function freezeDescriptor(descriptor: AdminCommandDescriptor): AdminCommandDescriptor {
  if (descriptor.authorization.kind === "any-of" || descriptor.authorization.kind === "all-of") {
    Object.freeze(descriptor.authorization.permissions);
  }
  Object.freeze(descriptor.authorization);
  Object.freeze(descriptor.flags);
  Object.freeze(descriptor.idempotency.evidence);
  Object.freeze(descriptor.idempotency);
  Object.freeze(descriptor.preview);
  Object.freeze(descriptor.execution.blockers);
  Object.freeze(descriptor.execution);
  Object.freeze(descriptor.input);
  Object.freeze(descriptor.result);
  return Object.freeze(descriptor);
}

const descriptors = ADMIN_OPENAPI_PATH_INVENTORY.flatMap(([pathTemplate, methods]) =>
  methods.map((method) => freezeDescriptor(buildDescriptor(method, pathTemplate))),
);

export const ADMIN_COMMAND_REGISTRY: readonly AdminCommandDescriptor[] = Object.freeze(descriptors);

const descriptorById = new Map(ADMIN_COMMAND_REGISTRY.map((descriptor) => [descriptor.id, descriptor]));
const descriptorByOperation = new Map(
  ADMIN_COMMAND_REGISTRY.map((descriptor) => [descriptor.operationKey, descriptor]),
);

function authorizationKey(authorization: AdminAuthorization): string {
  switch (authorization.kind) {
    case "permission":
      return `permission:${authorization.permission}`;
    case "any-of":
      return `any:${authorization.permissions.join(",")}`;
    case "all-of":
      return `all:${authorization.permissions.join(",")}`;
    case "any-admin":
      return "any-admin";
  }
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function adminCommandPolicyDigest(
  registry: readonly AdminCommandDescriptor[] = ADMIN_COMMAND_REGISTRY,
): string {
  const canonical = [...registry]
    .sort((left, right) => left.operationKey.localeCompare(right.operationKey))
    .map((descriptor) => JSON.stringify(descriptor))
    .join("\n");
  return `admin-command-v1-${registry.length}-${fnv1a(canonical)}`;
}

export const ADMIN_COMMAND_POLICY_DIGEST = adminCommandPolicyDigest();

export function describeAdminCapability(id: string): AdminCommandDescriptor | null {
  if (id.length > 180 || !/^admin\.api\.[a-z0-9.-]+$/.test(id)) return null;
  return descriptorById.get(id) ?? null;
}

export function resolveAdminApiCapability(
  method: AdminHttpMethod,
  pathTemplate: string,
): AdminCommandDescriptor | null {
  if (!isSafeAdminPathTemplate(pathTemplate)) return null;
  return descriptorByOperation.get(operationKey(method, pathTemplate)) ?? null;
}

export function searchAdminCapabilities(options: {
  readonly query?: string;
  readonly limit?: number;
  readonly readOnly?: boolean;
  readonly implementation?: AdminCapabilityImplementation;
} = {}): readonly AdminCommandDescriptor[] {
  const query = (options.query ?? "").trim().toLowerCase().slice(0, 120);
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 20), 50));

  return ADMIN_COMMAND_REGISTRY.filter((descriptor) => {
    if (options.readOnly !== undefined && descriptor.flags.readOnly !== options.readOnly) return false;
    if (options.implementation && descriptor.implementation !== options.implementation) return false;
    return !query || `${descriptor.id} ${descriptor.operationKey}`.toLowerCase().includes(query);
  }).slice(0, limit);
}

export function auditAdminCommandRegistry(
  registry: readonly AdminCommandDescriptor[] = ADMIN_COMMAND_REGISTRY,
): readonly string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  const operations = new Set<string>();

  for (const descriptor of registry) {
    const safePath = isSafeAdminPathTemplate(descriptor.pathTemplate);
    if (!safePath) {
      issues.push(`${descriptor.operationKey}: unsafe path template`);
    }
    if (descriptor.operationKey !== operationKey(descriptor.method, descriptor.pathTemplate)) {
      issues.push(`${descriptor.operationKey}: operation key does not match method/path template`);
    }
    if (safePath && descriptor.id !== capabilityId(descriptor.method, descriptor.pathTemplate)) {
      issues.push(`${descriptor.operationKey}: unstable capability ID`);
    }
    if (ids.has(descriptor.id)) issues.push(`${descriptor.id}: duplicate capability ID`);
    if (operations.has(descriptor.operationKey)) {
      issues.push(`${descriptor.operationKey}: duplicate operation`);
    }
    ids.add(descriptor.id);
    operations.add(descriptor.operationKey);

    if (!(["typed-command", "browser-adapter", "secure-manual"] as const)
      .includes(descriptor.implementation)) {
      issues.push(`${descriptor.operationKey}: unclassified implementation`);
    }

    const authModes = descriptor.authorization.kind === "any-admin"
      ? 1
      : descriptor.authorization.kind === "permission"
        ? Number(descriptor.authorization.permission.length > 0)
        : Number(descriptor.authorization.permissions.length > 0);
    if (authModes !== 1) issues.push(`${descriptor.operationKey}: ambiguous authorization`);
    if (safePath) {
      try {
        const effectiveAuthorization = normalizeAuthorization(
          getRoutePermission(samplePath(descriptor.pathTemplate), descriptor.method) as RoutePermissionShape | null,
          descriptor.operationKey,
        );
        if (authorizationKey(effectiveAuthorization) !== authorizationKey(descriptor.authorization)) {
          issues.push(`${descriptor.operationKey}: authorization drift from ROUTE_PERMISSIONS`);
        }
      } catch {
        issues.push(`${descriptor.operationKey}: unresolved or ambiguous ROUTE_PERMISSIONS`);
      }
    }

    if (!descriptor.flags.readOnly && descriptor.idempotency.policy !== "required") {
      issues.push(`${descriptor.operationKey}: mutation does not require idempotency`);
    }
    if (!descriptor.flags.readOnly && !descriptor.preview.required) {
      issues.push(`${descriptor.operationKey}: mutation does not require preview`);
    }
    if (descriptor.execution.enabled && !descriptor.flags.readOnly) {
      if (descriptor.implementation !== "typed-command") {
        issues.push(`${descriptor.operationKey}: only typed commands may enable mutation execution`);
      }
      const evidence = descriptor.idempotency.evidence;
      const proven = (evidence.kind === "inherent" && evidence.evidenceId.length > 0) ||
        (evidence.kind === "adapter" && evidence.implemented &&
          evidence.adapterName.length > 0 && Boolean(evidence.evidenceId));
      if (!proven) {
        issues.push(`${descriptor.operationKey}: executable mutation lacks implemented idempotency evidence`);
      }
      if (!descriptor.preview.supported || !descriptor.preview.evidenceId) {
        issues.push(`${descriptor.operationKey}: executable mutation lacks authoritative preview evidence`);
      }
    }
    if (
      descriptor.input.maxBodyBytes < 0 || descriptor.input.maxQueryChars <= 0 ||
      descriptor.input.maxPathParameterChars <= 0 || descriptor.input.maxItems <= 0 ||
      descriptor.input.maxStringChars <= 0 || descriptor.result.maxBytes <= 0 ||
      descriptor.result.maxItems <= 0
    ) {
      issues.push(`${descriptor.operationKey}: unbounded input or result metadata`);
    }
  }

  if (registry === ADMIN_COMMAND_REGISTRY && registry.length !== ADMIN_OPENAPI_OPERATION_COUNT) {
    issues.push(`operation count mismatch: ${registry.length} != ${ADMIN_OPENAPI_OPERATION_COUNT}`);
  }
  return issues;
}
