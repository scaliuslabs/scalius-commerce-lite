const DATABASE_MIGRATION_RETRY_AFTER_SECONDS = 60;

const ALLOWED_API_PROBE_PATHS = new Set([
  "/api/v1/health",
  "/api/v1/readyz",
]);

export interface DatabaseMigrationFreezeEnvironment {
  DATABASE_MIGRATION_FREEZE?: unknown;
}

export interface DatabaseMigrationFreezeResponseOptions {
  allowApiProbes?: boolean;
}

export function isDatabaseMigrationFrozen(
  env: DatabaseMigrationFreezeEnvironment,
): boolean {
  const value = String(env.DATABASE_MIGRATION_FREEZE ?? "")
    .trim()
    .toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

function isAllowedApiProbe(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return ALLOWED_API_PROBE_PATHS.has(new URL(request.url).pathname);
}

/**
 * Fail closed while the migration operator takes and verifies a database
 * snapshot.
 * API health/readiness probes may remain available so cutover can prove the
 * selected provider before buyer and merchant traffic is released.
 */
export function createDatabaseMigrationFreezeResponse(
  request: Request,
  env: DatabaseMigrationFreezeEnvironment,
  options: DatabaseMigrationFreezeResponseOptions = {},
): Response | null {
  if (!isDatabaseMigrationFrozen(env)) return null;
  if (options.allowApiProbes && isAllowedApiProbe(request)) return null;

  return Response.json({
    success: false,
    error: "Commerce data migration is in progress. Please retry shortly.",
    code: "DATABASE_MIGRATION_IN_PROGRESS",
  }, {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(DATABASE_MIGRATION_RETRY_AFTER_SECONDS),
    },
  });
}

export { DATABASE_MIGRATION_RETRY_AFTER_SECONDS };
