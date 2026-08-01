export type DatabaseProvider = "d1" | "turso";

export interface DatabaseProviderCapabilities {
  concurrentWrites: boolean;
  fts5: boolean;
  recursiveCte: boolean;
  sqliteDialect: true;
  withoutRowid: boolean;
}

const DATABASE_PROVIDER_CAPABILITIES: Record<
  DatabaseProvider,
  DatabaseProviderCapabilities
> = {
  d1: {
    concurrentWrites: false,
    fts5: true,
    recursiveCte: true,
    sqliteDialect: true,
    withoutRowid: true,
  },
  turso: {
    concurrentWrites: true,
    fts5: false,
    recursiveCte: false,
    sqliteDialect: true,
    withoutRowid: false,
  },
};

export function getDatabaseProviderCapabilities(
  provider: DatabaseProvider,
): DatabaseProviderCapabilities {
  return DATABASE_PROVIDER_CAPABILITIES[provider];
}

export interface DatabaseEnvironment extends Record<string, unknown> {
  DB?: D1Database;
  DATABASE_PROVIDER?: unknown;
  TURSO_DATABASE_URL?: unknown;
  TURSO_AUTH_TOKEN?: unknown;
}

export type DatabaseConfiguration =
  | {
      provider: "d1";
      binding: D1Database;
    }
  | {
      provider: "turso";
      url: string;
      authToken: string;
    };

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireTursoConfiguration(
  urlValue: unknown,
  tokenValue: unknown,
): Extract<DatabaseConfiguration, { provider: "turso" }> {
  const url = optionalString(urlValue);
  const authToken = optionalString(tokenValue);

  if (!url) {
    throw new Error(
      "Turso database configuration is incomplete: TURSO_DATABASE_URL is required.",
    );
  }
  if (!authToken) {
    throw new Error(
      "Turso database configuration is incomplete: TURSO_AUTH_TOKEN is required.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Turso database configuration is invalid: TURSO_DATABASE_URL must be a valid URL.",
    );
  }

  if (
    !["https:", "libsql:", "turso:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "Turso database configuration is invalid: TURSO_DATABASE_URL must be a credential-free Turso HTTPS URL.",
    );
  }

  return { provider: "turso", url, authToken };
}

/**
 * Resolve exactly one database provider from immutable deployment bindings.
 *
 * D1 is the zero-configuration default. Installing both Turso secrets selects
 * Turso automatically, so a hosted cutover only needs secret installation and
 * a Worker version rollout. DATABASE_PROVIDER remains an explicit rollback or
 * fail-closed override.
 */
export function resolveDatabaseConfiguration(
  env: DatabaseEnvironment = {},
): DatabaseConfiguration {
  const explicitProvider = optionalString(env.DATABASE_PROVIDER)?.toLowerCase();

  if (explicitProvider && explicitProvider !== "d1" && explicitProvider !== "turso") {
    throw new Error(
      `Unsupported DATABASE_PROVIDER ${JSON.stringify(explicitProvider)}. Expected "d1" or "turso".`,
    );
  }

  if (explicitProvider === "turso") {
    return requireTursoConfiguration(
      env.TURSO_DATABASE_URL,
      env.TURSO_AUTH_TOKEN,
    );
  }

  if (explicitProvider !== "d1" && (env.TURSO_DATABASE_URL || env.TURSO_AUTH_TOKEN)) {
    return requireTursoConfiguration(
      env.TURSO_DATABASE_URL,
      env.TURSO_AUTH_TOKEN,
    );
  }

  if (!env.DB) {
    throw new Error(
      "D1 database binding (env.DB) is not available. Configure the DB binding or install both Turso database secrets.",
    );
  }

  return { provider: "d1", binding: env.DB };
}
