export interface LoadTimingSample {
  serviceMs: number;
  scheduledMs: number;
  startLagMs: number;
}

export interface LoadTimingSummary {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface OpenArrivalResult<T> {
  value: T;
  timing: LoadTimingSample;
}

export interface OpenArrivalOptions<T> {
  count: number;
  ratePerSecond: number;
  execute: (sequence: number) => Promise<T>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  leadInMs?: number;
}

export const LOADTEST_TARGET_PURPOSE =
  "scalius-checkout-loadtest/v1" as const;

export interface LoadTargetIdentity {
  targetId: string;
  databaseHostname: string;
  fixtureNamespace: string;
}

export interface LoadTargetAcknowledgementInput {
  databaseUrl: string;
  acknowledgedDatabaseHostname: string;
  expectedTargetId: string;
  acknowledgedTargetId: string;
}

export interface TursoLoadBillingIsolationInput {
  loadOrganization: string;
  acknowledgedLoadOrganization: string;
  productionOrganization: string;
  acknowledgedProductionOrganization: string;
}

export interface TursoLoadBillingIsolation {
  loadOrganization: string;
  productionOrganization: string | null;
}

export function describeLoadTransportError(error: unknown): string {
  const labels: string[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { name?: unknown; code?: unknown; cause?: unknown };
    const label = typeof candidate.code === "string"
      ? candidate.code
      : typeof candidate.name === "string"
      ? candidate.name
      : "request_error";
    const normalized = label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
    if (normalized && labels.at(-1) !== normalized) labels.push(normalized);
    current = candidate.cause;
  }
  return labels.join(":") || "request_error";
}

interface LoadTargetSentinelInput extends LoadTargetAcknowledgementInput {
  sentinelRows: readonly Record<string, unknown>[];
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
}

function normalizeOrganization(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(normalized)) {
    throw new Error(
      `${label} must contain only lowercase letters, numbers, and internal dashes.`,
    );
  }
  return normalized;
}

/**
 * A disposable database or group does not isolate Turso's organization-wide
 * row quotas. Live capacity tests must therefore use a billing organization
 * that is distinct from the organization serving production databases.
 */
export function assertTursoLoadBillingIsolation(
  input: TursoLoadBillingIsolationInput,
): TursoLoadBillingIsolation {
  const loadOrganization = normalizeOrganization(
    input.loadOrganization,
    "LOADTEST_TURSO_ORGANIZATION",
  );
  if (
    normalizeOrganization(
      input.acknowledgedLoadOrganization,
      "LOADTEST_ACK_TURSO_ORGANIZATION",
    ) !== loadOrganization
  ) {
    throw new Error(
      "LOADTEST_ACK_TURSO_ORGANIZATION must exactly match the load organization.",
    );
  }

  const productionInput = input.productionOrganization.trim().toLowerCase();
  const acknowledgedProductionInput = input.acknowledgedProductionOrganization
    .trim()
    .toLowerCase();
  if (productionInput === "none") {
    if (acknowledgedProductionInput !== "none") {
      throw new Error(
        "LOADTEST_ACK_PRODUCTION_TURSO_ORGANIZATION must exactly acknowledge none.",
      );
    }
    return { loadOrganization, productionOrganization: null };
  }

  const productionOrganization = normalizeOrganization(
    productionInput,
    "PRODUCTION_TURSO_ORGANIZATION",
  );
  if (
    normalizeOrganization(
      acknowledgedProductionInput,
      "LOADTEST_ACK_PRODUCTION_TURSO_ORGANIZATION",
    ) !== productionOrganization
  ) {
    throw new Error(
      "LOADTEST_ACK_PRODUCTION_TURSO_ORGANIZATION must exactly match the production organization.",
    );
  }
  if (productionOrganization === loadOrganization) {
    throw new Error(
      "Turso load tests must use a billing organization isolated from production row quotas.",
    );
  }
  return { loadOrganization, productionOrganization };
}

export function assertDisposableLoadTarget(
  apiUrl: string,
  acknowledgedHostname: string,
): URL {
  const parsed = new URL(apiUrl);
  const hostname = parsed.hostname.toLowerCase();
  const localLoopback = parsed.protocol === "http:"
    && (hostname === "localhost" || hostname.endsWith(".localhost"));
  if (parsed.protocol !== "https:" && !localLoopback) {
    throw new Error("Live checkout load targets must use HTTPS or explicit loopback HTTP.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw new Error("Live checkout load target must be a credential-free origin URL.");
  }
  if (!hostname.includes("loadtest")) {
    throw new Error("Live checkout load target hostname must contain loadtest.");
  }
  if (acknowledgedHostname.trim().toLowerCase() !== hostname) {
    throw new Error("LOADTEST_ACK_HOST must exactly match the target hostname.");
  }
  return new URL(parsed.origin);
}

export function assertDisposableDatabaseProvisionTarget(
  input: LoadTargetAcknowledgementInput,
): LoadTargetIdentity {
  const parsed = new URL(input.databaseUrl);
  const hostname = parsed.hostname.toLowerCase();
  const isPostgres = parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
  if (isPostgres) {
    const encodedDatabase = parsed.pathname.slice(1);
    let databaseName: string;
    try {
      databaseName = decodeURIComponent(encodedDatabase).toLowerCase();
    } catch {
      throw new Error("Live checkout load PostgreSQL URL has an invalid database name.");
    }
    if (
      !hostname ||
      parsed.hash ||
      !encodedDatabase ||
      encodedDatabase.includes("/")
    ) {
      throw new Error("Live checkout load PostgreSQL URL must name exactly one database.");
    }
    if (!databaseName.includes("loadtest")) {
      throw new Error("Live checkout load PostgreSQL database name must contain loadtest.");
    }
  } else {
    if (parsed.protocol !== "https:" && parsed.protocol !== "turso:") {
      throw new Error(
        "Live checkout load databases must use HTTPS, Turso, or PostgreSQL URLs.",
      );
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname && parsed.pathname !== "/")
    ) {
      throw new Error("Live checkout load database must be a credential-free origin URL.");
    }
    if (!hostname.includes("loadtest")) {
      throw new Error("Live checkout load database hostname must contain loadtest.");
    }
  }
  if (input.acknowledgedDatabaseHostname.trim().toLowerCase() !== hostname) {
    throw new Error(
      "LOADTEST_ACK_DATABASE_HOST must exactly match the database hostname.",
    );
  }

  const targetId = input.expectedTargetId.trim().toLowerCase();
  if (!/^lt_[a-z0-9]{16,64}$/.test(targetId)) {
    throw new Error(
      "LOADTEST_TARGET_ID must be lt_ followed by 16 to 64 lowercase letters or digits.",
    );
  }
  if (input.acknowledgedTargetId.trim().toLowerCase() !== targetId) {
    throw new Error("LOADTEST_ACK_TARGET_ID must exactly match LOADTEST_TARGET_ID.");
  }
  return {
    targetId,
    databaseHostname: hostname,
    fixtureNamespace: targetId,
  };
}

export function assertDisposableDatabaseTarget(
  input: LoadTargetSentinelInput,
): LoadTargetIdentity {
  const acknowledged = assertDisposableDatabaseProvisionTarget(input);
  if (input.sentinelRows.length !== 1) {
    throw new Error(
      "Load-test database must contain exactly one scalius_loadtest_target sentinel row.",
    );
  }

  const row = input.sentinelRows[0]!;
  if (row.purpose !== LOADTEST_TARGET_PURPOSE) {
    throw new Error("Load-test database sentinel has the wrong purpose.");
  }
  if (String(row.target_id ?? "").toLowerCase() !== acknowledged.targetId) {
    throw new Error("Load-test database sentinel target id does not match.");
  }
  if (
    String(row.database_hostname ?? "").toLowerCase()
    !== acknowledged.databaseHostname
  ) {
    throw new Error("Load-test database sentinel hostname does not match.");
  }

  const fixtureNamespace = String(row.fixture_namespace ?? "").toLowerCase();
  if (fixtureNamespace !== acknowledged.fixtureNamespace) {
    throw new Error("Load-test database sentinel fixture namespace does not match.");
  }

  return {
    targetId: acknowledged.targetId,
    databaseHostname: acknowledged.databaseHostname,
    fixtureNamespace,
  };
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error("Percentile fraction must be between zero and one.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

export function summarizeTimings(
  samples: readonly LoadTimingSample[],
  field: keyof LoadTimingSample,
): LoadTimingSummary {
  const values = samples.map((sample) => sample[field]);
  if (values.length === 0) {
    return { min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  return {
    min: Math.round(Math.min(...values)),
    p50: Math.round(percentile(values, 0.5)),
    p95: Math.round(percentile(values, 0.95)),
    p99: Math.round(percentile(values, 0.99)),
    max: Math.round(Math.max(...values)),
  };
}

export async function runOpenArrival<T>(
  options: OpenArrivalOptions<T>,
): Promise<readonly OpenArrivalResult<T>[]> {
  requirePositiveInteger(options.count, "Open-arrival count");
  requirePositiveFinite(options.ratePerSecond, "Open-arrival rate");
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(
    (resolve) => setTimeout(resolve, milliseconds),
  ));
  const leadInMs = options.leadInMs ?? 100;
  if (!Number.isFinite(leadInMs) || leadInMs < 0) {
    throw new Error("Open-arrival lead-in must be a non-negative finite number.");
  }

  const intervalMs = 1_000 / options.ratePerSecond;
  const origin = now() + leadInMs;
  return Promise.all(Array.from({ length: options.count }, async (_, index) => {
    const scheduledAt = origin + index * intervalMs;
    const delay = scheduledAt - now();
    if (delay > 0) await sleep(delay);
    const startedAt = now();
    const value = await options.execute(index + 1);
    const completedAt = now();
    return {
      value,
      timing: {
        serviceMs: completedAt - startedAt,
        scheduledMs: completedAt - scheduledAt,
        startLagMs: Math.max(0, startedAt - scheduledAt),
      },
    };
  }));
}
