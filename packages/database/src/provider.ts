export type DatabaseProvider = "d1" | "turso" | "postgres";

export interface DatabaseProviderCapabilities {
  concurrentWrites: boolean;
  fts5: boolean;
  recursiveCte: boolean;
  sqliteDialect: boolean;
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
  postgres: {
    concurrentWrites: true,
    fts5: false,
    recursiveCte: true,
    sqliteDialect: false,
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
  HYPERDRIVE?: { connectionString: string };
  DATABASE_PROVIDER?: unknown;
  TURSO_DATABASE_URL?: unknown;
  TURSO_AUTH_TOKEN?: unknown;
  POSTGRES_DATABASE_URL?: unknown;
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
      writeBatchMode: "immediate" | "concurrent";
    }
  | {
      provider: "postgres";
      connectionString: string;
      transport: "neon-http" | "native";
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

  return {
    provider: "turso",
    url,
    authToken,
    // Turso Cloud gives the Rust/TursoDB engine a `turso://` endpoint and
    // legacy libSQL databases a `libsql://` endpoint. Keep the compatibility
    // path conservative while activating MVCC without another deployment
    // setting for every operator-provisioned TursoDB database.
    writeBatchMode: parsed.protocol === "turso:" ? "concurrent" : "immediate",
  };
}

function requirePostgresConfiguration(
  connectionStringValue: unknown,
  hyperdriveValue: unknown,
): Extract<DatabaseConfiguration, { provider: "postgres" }> {
  const hyperdrive = hyperdriveValue && typeof hyperdriveValue === "object"
    ? optionalString(Reflect.get(hyperdriveValue, "connectionString"))
    : undefined;
  const connectionString = hyperdrive ?? optionalString(connectionStringValue);
  if (!connectionString) {
    throw new Error(
      "PostgreSQL database configuration is incomplete: POSTGRES_DATABASE_URL or HYPERDRIVE is required.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(
      "PostgreSQL database configuration is invalid: POSTGRES_DATABASE_URL must be a valid PostgreSQL connection string.",
    );
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
    || !parsed.hostname
    || !parsed.pathname
    || parsed.pathname === "/"
  ) {
    throw new Error(
      "PostgreSQL database configuration is invalid: POSTGRES_DATABASE_URL must use postgres:// or postgresql:// and name a database.",
    );
  }
  return {
    provider: "postgres",
    connectionString,
    transport: hyperdrive || !parsed.hostname.toLowerCase().endsWith(".neon.tech")
      ? "native"
      : "neon-http",
  };
}

/**
 * Resolve exactly one database provider from immutable deployment bindings.
 *
 * D1 is the zero-configuration default. Complete Turso or PostgreSQL
 * credentials select that external provider when the configuration is
 * unambiguous. DATABASE_PROVIDER remains an explicit cutover/rollback pin.
 */
export function resolveDatabaseConfiguration(
  env: DatabaseEnvironment = {},
): DatabaseConfiguration {
  const explicitProvider = optionalString(env.DATABASE_PROVIDER)?.toLowerCase();

  if (
    explicitProvider
    && explicitProvider !== "d1"
    && explicitProvider !== "turso"
    && explicitProvider !== "postgres"
  ) {
    throw new Error(
      `Unsupported DATABASE_PROVIDER ${JSON.stringify(explicitProvider)}. Expected "d1", "turso", or "postgres".`,
    );
  }

  if (explicitProvider === "turso") {
    return requireTursoConfiguration(
      env.TURSO_DATABASE_URL,
      env.TURSO_AUTH_TOKEN,
    );
  }

  if (explicitProvider === "postgres") {
    return requirePostgresConfiguration(
      env.POSTGRES_DATABASE_URL,
      env.HYPERDRIVE,
    );
  }

  const hasTursoConfiguration = Boolean(env.TURSO_DATABASE_URL || env.TURSO_AUTH_TOKEN);
  const hasPostgresConfiguration = Boolean(
    env.POSTGRES_DATABASE_URL || env.HYPERDRIVE,
  );
  if (
    explicitProvider !== "d1"
    && hasTursoConfiguration
    && hasPostgresConfiguration
  ) {
    throw new Error(
      "Database configuration is ambiguous: Turso and PostgreSQL credentials are both installed. Set DATABASE_PROVIDER explicitly.",
    );
  }

  if (explicitProvider !== "d1" && hasPostgresConfiguration) {
    return requirePostgresConfiguration(
      env.POSTGRES_DATABASE_URL,
      env.HYPERDRIVE,
    );
  }

  if (explicitProvider !== "d1" && hasTursoConfiguration) {
    return requireTursoConfiguration(
      env.TURSO_DATABASE_URL,
      env.TURSO_AUTH_TOKEN,
    );
  }

  if (!env.DB) {
    throw new Error(
      "D1 database binding (env.DB) is not available. Configure DB or install one complete external database configuration.",
    );
  }

  return { provider: "d1", binding: env.DB };
}
