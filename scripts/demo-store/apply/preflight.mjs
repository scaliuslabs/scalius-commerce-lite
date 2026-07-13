const MUTATION_PERMISSIONS = Object.freeze([
  { method: "POST", path: /^\/api\/v1\/admin\/attributes$/u, permission: "attributes.create" },
  { method: "POST", path: /^\/api\/v1\/admin\/categories$/u, permission: "categories.create" },
  { method: ["PUT", "PATCH"], path: /^\/api\/v1\/admin\/categories\//u, permission: "categories.edit" },
  { method: "POST", path: /^\/api\/v1\/admin\/products$/u, permission: "products.create" },
  { method: ["PUT", "PATCH"], path: /^\/api\/v1\/admin\/products\//u, permission: "products.edit" },
  { method: "POST", path: /^\/api\/v1\/admin\/collections$/u, permission: "collections.create" },
  { method: ["PUT", "PATCH"], path: /^\/api\/v1\/admin\/collections\//u, permission: "collections.edit" },
  { method: "POST", path: /^\/api\/v1\/admin\/settings\/theme$/u, permission: "settings.general.edit" },
  { method: ["POST", "PUT"], path: /^\/api\/v1\/admin\/settings\/hero-sliders(?:\/|$)/u, permission: "settings.header.edit" },
]);

function methodMatches(rule, method) {
  return Array.isArray(rule.method) ? rule.method.includes(method) : rule.method === method;
}

export function assertApplyExclusions({ publicationIntent = {}, readinessReport }) {
  if (publicationIntent.navigation?.header || publicationIntent.navigation?.footer) {
    throw new Error("Header/footer publication is unrevisioned and excluded from demo apply.");
  }
  if (publicationIntent.promotions?.length) {
    throw new Error("Standalone promotion publication is unrevisioned and excluded from demo apply.");
  }
  if (readinessReport?.presentation?.header || readinessReport?.presentation?.footer) {
    throw new Error("Remote Media readiness must not contain header/footer write intent.");
  }
  if (readinessReport?.presentation?.promotions?.length) {
    throw new Error("Remote Media readiness must not contain standalone promotion write intent.");
  }
  if (readinessReport?.unversionedSettings?.length) {
    throw new Error("Remote Media readiness contains unversioned settings write intent.");
  }
}

export function requiredPermissionsForLifecycle(lifecycle) {
  const permissions = new Set();
  for (const phase of lifecycle?.phases ?? []) {
    if (phase.state !== "ready") continue;
    for (const command of phase.commands ?? []) {
      const rule = MUTATION_PERMISSIONS.find((candidate) =>
        methodMatches(candidate, command.method) && candidate.path.test(command.path),
      );
      if (!rule) throw new Error(`No permission preflight rule exists for ${command.method} ${command.path}.`);
      permissions.add(rule.permission);
    }
  }
  return [...permissions].sort();
}

export function assertApplyPermissions(permissionContext, lifecycle) {
  if (!permissionContext || typeof permissionContext !== "object" || !Array.isArray(permissionContext.permissions)) {
    throw new Error("Admin permission preflight returned an invalid permission context.");
  }
  const required = requiredPermissionsForLifecycle(lifecycle);
  const granted = new Set(permissionContext.permissions);
  const missing = permissionContext.isSuperAdmin === true
    ? []
    : required.filter((permission) => !granted.has(permission));
  if (missing.length) throw new Error(`Admin permission preflight is missing: ${missing.join(", ")}.`);
  return { required, isSuperAdmin: permissionContext.isSuperAdmin === true };
}
