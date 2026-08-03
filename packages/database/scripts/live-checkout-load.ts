import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Agent, fetch as loadFetch } from "undici";

import {
  createTursoPortabilityExecutor,
  type SqlitePortabilityExecutor,
} from "../src/portability";
import { connectNeonPostgres } from "../src/postgres-adapter";
import {
  compileSqliteStatementForPostgres,
  normalizePostgresParameters,
  normalizePostgresResultObjects,
} from "../src/postgres-sqlite-profile";
import { assertDatabaseSchemaCompatible } from "../src/schema-contract";
import {
  assertDisposableDatabaseTarget,
  assertDisposableLoadTarget,
  assertTursoLoadBillingIsolation,
  describeLoadTransportError,
  runOpenArrival,
  summarizeTimings,
  type LoadTargetIdentity,
  type LoadTimingSample,
  type OpenArrivalResult,
} from "./live-checkout-load-core";
import { preflightTursoLoadBudget } from "./turso-platform-upload";

interface FixtureVariant {
  productId: string;
  variantId: string;
  price: number;
  label: string;
}

interface LoadFixture {
  cityId: string;
  zoneId: string;
  areaId: string;
  shippingMethodId: string;
  shippingCharge: number;
  spread: FixtureVariant;
  hot: FixtureVariant;
}

interface LoadOptions {
  databaseProvider: "turso" | "d1" | "postgres";
  apiOrigin: string;
  databaseUrl: string;
  databaseToken: string;
  acknowledgedDatabaseHostname: string;
  targetId: string;
  acknowledgedTargetId: string;
  d1?: {
    databaseName: string;
    databaseId: string;
    configPath: string;
    binding: string;
  };
  tursoBilling?: {
    organization: string;
    platformToken: string;
    rowsReadBudget: number;
    rowsWrittenBudget: number;
    allowUsageOverage: boolean;
  };
  fixture: LoadFixture;
  scenario: "smoke" | "idempotency" | "spread" | "hot" | "all";
  idempotencyRequests: number;
  spreadOrders: number;
  spreadRate: number;
  hotOrders: number;
  hotRate: number;
  timeoutMs: number;
  clientConnections: number;
  dispatcher?: Agent;
}

interface SafeHttpResult {
  status: number;
  orderId: string | null;
  errorCode: string | null;
  checkoutPhaseMs?: Record<string, number>;
  privateProof?: {
    receiptToken: string;
  };
}

interface ScenarioSummary {
  scenario: string;
  passed: boolean;
  violations: string[];
  requested: number;
  statusCounts: Record<string, number>;
  errorCodeCounts: Record<string, number>;
  serviceLatencyMs: ReturnType<typeof summarizeTimings>;
  scheduledLatencyMs: ReturnType<typeof summarizeTimings>;
  startLagMs: ReturnType<typeof summarizeTimings>;
  checkoutPhaseLatencyMs: Record<string, ReturnType<typeof summarizeTimings>>;
  elapsedMs: number;
  achievedPerSecond: number;
  oracle: Record<string, string | number | boolean>;
}

function parseCheckoutServerTiming(value: string | null): Record<string, number> | undefined {
  if (!value) return undefined;
  const phases: Record<string, number> = {};
  for (const entry of value.split(",")) {
    const match = /^\s*([a-z_]+)\s*;\s*dur=([0-9]+(?:\.[0-9]+)?)\s*$/.exec(entry);
    if (!match) continue;
    const duration = Number(match[2]);
    if (Number.isFinite(duration) && duration >= 0) phases[match[1]!] = duration;
  }
  return Object.keys(phases).length > 0 ? phases : undefined;
}

interface VariantState {
  stock: number;
  reservedStock: number;
  stockVersion: number;
  trackInventory: number;
}

interface ReservationLaneState {
  lane: number;
  capacity: number;
  reservedQuantity: number;
  version: number;
  sourceStockVersion: number;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parsePositiveNumber(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = parsePositiveNumber(value, fallback, name);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer.`);
  return parsed;
}

function readD1TargetOptions(): NonNullable<LoadOptions["d1"]> {
  const databaseName = requiredEnvironment("LOADTEST_D1_DATABASE_NAME").toLowerCase();
  const acknowledgedName = requiredEnvironment("LOADTEST_ACK_D1_DATABASE_NAME").toLowerCase();
  const databaseId = requiredEnvironment("LOADTEST_D1_DATABASE_ID").toLowerCase();
  const acknowledgedId = requiredEnvironment("LOADTEST_ACK_D1_DATABASE_ID").toLowerCase();
  const binding = process.env.LOADTEST_D1_BINDING?.trim() || "DB";
  const configPath = resolve(process.cwd(), requiredEnvironment("LOADTEST_D1_CONFIG"));
  if (!databaseName.includes("loadtest") || acknowledgedName !== databaseName) {
    throw new Error("D1 load target name must contain loadtest and match its acknowledgement exactly.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(databaseId) || acknowledgedId !== databaseId) {
    throw new Error("D1 load target id must be a UUID and match its acknowledgement exactly.");
  }

  const rawConfig = readFileSync(configPath, "utf8");
  const config = JSON.parse(rawConfig.replace(/(?<!https?:)\/\/[^\n]*/g, "")) as {
    name?: unknown;
    d1_databases?: Array<{
      binding?: unknown;
      database_name?: unknown;
      database_id?: unknown;
    }>;
  };
  if (typeof config.name !== "string" || !config.name.toLowerCase().includes("loadtest")) {
    throw new Error("D1 load target Wrangler config must name a loadtest Worker.");
  }
  const configured = config.d1_databases?.find((candidate) => candidate.binding === binding);
  if (
    configured?.database_name !== databaseName
    || configured.database_id?.toLowerCase() !== databaseId
  ) {
    throw new Error("D1 load target Wrangler binding does not exactly match the acknowledged database.");
  }
  return { databaseName, databaseId, configPath, binding };
}

function parseArguments(argv: readonly string[]): LoadOptions {
  let scenario: LoadOptions["scenario"] = "all";
  let idempotencyRequests = 25;
  let spreadOrders = 20;
  let spreadRate = 5;
  let hotOrders = 60;
  let hotRate = 30;
  let timeoutMs = 30_000;
  let clientConnections = 256;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--scenario") {
      const candidate = argv[++index];
      if (!candidate || !["smoke", "idempotency", "spread", "hot", "all"].includes(candidate)) {
        throw new Error("--scenario must be smoke, idempotency, spread, hot, or all.");
      }
      scenario = candidate as LoadOptions["scenario"];
    } else if (argument === "--idempotency-requests") {
      idempotencyRequests = parsePositiveInteger(argv[++index], idempotencyRequests, argument);
    } else if (argument === "--spread-orders") {
      spreadOrders = parsePositiveInteger(argv[++index], spreadOrders, argument);
    } else if (argument === "--spread-rate") {
      spreadRate = parsePositiveNumber(argv[++index], spreadRate, argument);
    } else if (argument === "--hot-orders") {
      hotOrders = parsePositiveInteger(argv[++index], hotOrders, argument);
    } else if (argument === "--hot-rate") {
      hotRate = parsePositiveNumber(argv[++index], hotRate, argument);
    } else if (argument === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(argv[++index], timeoutMs, argument);
    } else if (argument === "--client-connections") {
      clientConnections = parsePositiveInteger(
        argv[++index],
        clientConnections,
        argument,
      );
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
    }
  }

  const apiUrl = requiredEnvironment("LOADTEST_API_URL");
  const apiOrigin = assertDisposableLoadTarget(
    apiUrl,
    requiredEnvironment("LOADTEST_ACK_HOST"),
  ).origin;
  const databaseProvider = requiredEnvironment("LOADTEST_DATABASE_PROVIDER")
    .toLowerCase();
  if (!(["d1", "turso", "postgres"] as const).includes(
    databaseProvider as "d1" | "turso" | "postgres",
  )) {
    throw new Error("LOADTEST_DATABASE_PROVIDER must be d1, turso, or postgres.");
  }
  const selectedProvider = databaseProvider as LoadOptions["databaseProvider"];
  const d1 = selectedProvider === "d1"
    ? readD1TargetOptions()
    : undefined;
  const tursoBillingIsolation = selectedProvider === "turso"
    ? assertTursoLoadBillingIsolation({
        loadOrganization: requiredEnvironment("LOADTEST_TURSO_ORGANIZATION"),
        acknowledgedLoadOrganization: requiredEnvironment(
          "LOADTEST_ACK_TURSO_ORGANIZATION",
        ),
        productionOrganization: requiredEnvironment(
          "PRODUCTION_TURSO_ORGANIZATION",
        ),
        acknowledgedProductionOrganization: requiredEnvironment(
          "LOADTEST_ACK_PRODUCTION_TURSO_ORGANIZATION",
        ),
      })
    : undefined;
  const databaseUrl = selectedProvider === "d1"
    ? `https://${d1!.databaseName}`
    : selectedProvider === "turso"
    ? requiredEnvironment("TURSO_DATABASE_URL")
    : requiredEnvironment("POSTGRES_DATABASE_URL");
  const parsedDatabaseUrl = new URL(databaseUrl);
  if (
    selectedProvider !== "postgres"
    && (parsedDatabaseUrl.username || parsedDatabaseUrl.password)
  ) {
    throw new Error("TURSO_DATABASE_URL must not contain credentials.");
  }

  return {
    databaseProvider: selectedProvider,
    apiOrigin,
    databaseUrl,
    databaseToken: selectedProvider === "turso"
      ? requiredEnvironment("TURSO_AUTH_TOKEN")
      : "",
    acknowledgedDatabaseHostname: requiredEnvironment(
      "LOADTEST_ACK_DATABASE_HOST",
    ),
    targetId: requiredEnvironment("LOADTEST_TARGET_ID"),
    acknowledgedTargetId: requiredEnvironment("LOADTEST_ACK_TARGET_ID"),
    d1,
    tursoBilling: tursoBillingIsolation
      ? {
          organization: tursoBillingIsolation.loadOrganization,
          platformToken: requiredEnvironment("TURSO_PLATFORM_API_TOKEN"),
          rowsReadBudget: parsePositiveInteger(
            process.env.LOADTEST_TURSO_ROWS_READ_BUDGET,
            0,
            "LOADTEST_TURSO_ROWS_READ_BUDGET",
          ),
          rowsWrittenBudget: parsePositiveInteger(
            process.env.LOADTEST_TURSO_ROWS_WRITTEN_BUDGET,
            0,
            "LOADTEST_TURSO_ROWS_WRITTEN_BUDGET",
          ),
          allowUsageOverage:
            process.env.LOADTEST_ALLOW_TURSO_USAGE_OVERAGE?.trim() === "yes",
        }
      : undefined,
    fixture: {
      cityId: requiredEnvironment("LOADTEST_CITY_ID"),
      zoneId: requiredEnvironment("LOADTEST_ZONE_ID"),
      areaId: requiredEnvironment("LOADTEST_AREA_ID"),
      shippingMethodId: requiredEnvironment("LOADTEST_SHIPPING_METHOD_ID"),
      shippingCharge: parsePositiveNumber(
        requiredEnvironment("LOADTEST_SHIPPING_CHARGE"),
        0,
        "LOADTEST_SHIPPING_CHARGE",
      ),
      spread: {
        productId: requiredEnvironment("LOADTEST_SPREAD_PRODUCT_ID"),
        variantId: requiredEnvironment("LOADTEST_SPREAD_VARIANT_ID"),
        price: parsePositiveNumber(requiredEnvironment("LOADTEST_SPREAD_PRICE"), 0, "LOADTEST_SPREAD_PRICE"),
        label: "spread",
      },
      hot: {
        productId: requiredEnvironment("LOADTEST_HOT_PRODUCT_ID"),
        variantId: requiredEnvironment("LOADTEST_HOT_VARIANT_ID"),
        price: parsePositiveNumber(requiredEnvironment("LOADTEST_HOT_PRICE"), 0, "LOADTEST_HOT_PRICE"),
        label: "hot",
      },
    },
    scenario,
    idempotencyRequests,
    spreadOrders,
    spreadRate,
    hotOrders,
    hotRate,
    timeoutMs,
    clientConnections,
  };
}

function scalarNumber(rows: readonly Record<string, unknown>[], key: string): number {
  const value = Number(rows[0]?.[key]);
  if (!Number.isFinite(value)) throw new Error(`Database oracle did not return numeric ${key}.`);
  return value;
}

type LoadQueryParameter = null | string | number | bigint | boolean | Uint8Array;

function sqliteLiteral(value: LoadQueryParameter): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("D1 oracle query received a non-finite number.");
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return `X'${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}'`;
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function bindD1OracleQuery(
  sql: string,
  params: readonly LoadQueryParameter[],
): string {
  let index = 0;
  const bound = sql.replaceAll("?", () => {
    const value = params[index++];
    if (value === undefined) throw new Error("D1 oracle query is missing a bound parameter.");
    return sqliteLiteral(value);
  });
  if (index !== params.length) {
    throw new Error("D1 oracle query received unused bound parameters.");
  }
  return bound;
}

function createD1CliOracle(options: NonNullable<LoadOptions["d1"]>): SqlitePortabilityExecutor {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  return {
    async query(sql, params = []) {
      const command = bindD1OracleQuery(sql, params as readonly LoadQueryParameter[]);
      const stdout = execFileSync(
        process.env.SCALIUS_PNPM_BIN || "pnpm",
        [
          "--dir",
          resolve(repositoryRoot, "apps/api"),
          "exec",
          "wrangler",
          "d1",
          "execute",
          options.binding,
          "--remote",
          "--config",
          options.configPath,
          "--command",
          command,
          "--json",
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          maxBuffer: 20 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const payload = JSON.parse(stdout) as Array<{
        success?: boolean;
        results?: Record<string, unknown>[];
      }>;
      if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.success !== true) {
        throw new Error("D1 oracle query did not return one successful result.");
      }
      return payload[0].results ?? [];
    },
  };
}

function createLoadOracle(options: LoadOptions): SqlitePortabilityExecutor {
  if (options.databaseProvider === "d1") {
    if (!options.d1) throw new Error("D1 load target options are missing.");
    return createD1CliOracle(options.d1);
  }
  if (options.databaseProvider === "postgres") {
    const connection = connectNeonPostgres(options.databaseUrl);
    return {
      async query(sql, params = []) {
        const compiled = compileSqliteStatementForPostgres(sql, params.length);
        if (!compiled.readOnly) {
          throw new Error("PostgreSQL load oracle accepts read-only SQL only.");
        }
        const result = await connection.query(
          compiled.sql,
          normalizePostgresParameters(params),
        );
        if (result.fields.some((field) => !field.name)) {
          throw new Error("PostgreSQL load oracle result field is missing its name.");
        }
        return normalizePostgresResultObjects(
          result.rows,
          result.fields as { name: string; dataTypeID: number }[],
        );
      },
    };
  }
  return createTursoPortabilityExecutor({
    url: options.databaseUrl,
    authToken: options.databaseToken,
  });
}

async function readVariantState(
  oracle: SqlitePortabilityExecutor,
  variantId: string,
): Promise<VariantState> {
  const rows = await oracle.query(
    `SELECT stock, reserved_stock, stock_version, track_inventory
       FROM product_variants WHERE id = ?`,
    [variantId],
  );
  if (rows.length !== 1) throw new Error("Database oracle could not find the load-test variant.");
  return {
    stock: scalarNumber(rows, "stock"),
    reservedStock: scalarNumber(rows, "reserved_stock"),
    stockVersion: scalarNumber(rows, "stock_version"),
    trackInventory: scalarNumber(rows, "track_inventory"),
  };
}

async function readReservationLaneState(
  oracle: SqlitePortabilityExecutor,
  variantId: string,
): Promise<ReservationLaneState[]> {
  const rows = await oracle.query(
    `SELECT lane, capacity, reserved_quantity, version, source_stock_version
       FROM inventory_reservation_lanes
      WHERE variant_id = ? AND pool = 'regular'
      ORDER BY lane`,
    [variantId],
  );
  return rows.map((row) => ({
    lane: Number(row.lane),
    capacity: Number(row.capacity),
    reservedQuantity: Number(row.reserved_quantity),
    version: Number(row.version),
    sourceStockVersion: Number(row.source_stock_version),
  }));
}

async function readRunFacts(
  oracle: SqlitePortabilityExecutor,
  notes: string,
): Promise<Record<string, number>> {
  const rows = await oracle.query(
    `SELECT
       (SELECT COUNT(*) FROM orders WHERE notes = ?) AS orders_count,
       (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.notes = ?) AS items_count,
       (SELECT COUNT(*) FROM checkout_attempts ca JOIN orders o ON o.id = ca.order_id WHERE o.notes = ?) AS attempts_count,
       (SELECT COUNT(*) FROM inventory_movements im JOIN orders o ON o.id = im.order_id WHERE o.notes = ?) AS movements_count,
       (SELECT COUNT(*) FROM order_support_requests osr JOIN orders o ON o.id = osr.order_id WHERE o.notes = ?) AS support_count`,
    [notes, notes, notes, notes, notes],
  );
  return {
    orders: scalarNumber(rows, "orders_count"),
    items: scalarNumber(rows, "items_count"),
    attempts: scalarNumber(rows, "attempts_count"),
    movements: scalarNumber(rows, "movements_count"),
    supportRequests: scalarNumber(rows, "support_count"),
  };
}

async function waitForProjectedRunFacts(
  oracle: SqlitePortabilityExecutor,
  notes: string,
  expected: { orders: number; items: number; attempts: number },
  timeoutMs: number,
): Promise<{ facts: Record<string, number>; projectionCatchupMs: number }> {
  const startedAt = performance.now();
  let facts = await readRunFacts(oracle, notes);
  while (
    (
      facts.orders !== expected.orders
      || facts.items !== expected.items
      || facts.attempts !== expected.attempts
    )
    && performance.now() - startedAt < timeoutMs
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    facts = await readRunFacts(oracle, notes);
  }
  return {
    facts,
    projectionCatchupMs: Math.round(performance.now() - startedAt),
  };
}

async function assertDatabaseHealth(
  oracle: SqlitePortabilityExecutor,
  provider: LoadOptions["databaseProvider"],
): Promise<Record<string, string | number>> {
  if (provider === "postgres") {
    const [schemaRows, objectRows, invalidForeignKeyRows] = await Promise.all([
      oracle.query(
        `SELECT version, name, source_sha256
           FROM scalius_schema_migrations
          ORDER BY version`,
      ),
      oracle.query(
        `SELECT COUNT(*) AS schema_objects
           FROM information_schema.tables
          WHERE table_schema = 'public'`,
      ),
      oracle.query(
        `SELECT constraint_name
           FROM information_schema.table_constraints
          WHERE constraint_schema = 'public'
            AND constraint_type = 'FOREIGN KEY'
            AND constraint_name IN (
              SELECT conname
                FROM pg_constraint
               WHERE contype = 'f' AND NOT convalidated
            )`,
      ),
    ]);
    assertDatabaseSchemaCompatible(schemaRows.map((row) => ({
      version: row.version,
      name: row.name,
      sourceSha256: row.source_sha256,
    })));
    const schemaObjects = scalarNumber(objectRows, "schema_objects");
    if (schemaObjects < 1) throw new Error("PostgreSQL load target has no public tables.");
    if (invalidForeignKeyRows.length !== 0) {
      throw new Error(
        `PostgreSQL has ${invalidForeignKeyRows.length} unvalidated foreign-key constraints.`,
      );
    }
    return {
      integrity: "postgres-constraints",
      foreignKeyViolations: 0,
      journalMode: "postgres-mvcc",
      schemaObjects,
    };
  }
  const [integrityRows, foreignKeyRows] = await Promise.all([
    provider === "turso"
      ? oracle.query("PRAGMA integrity_check")
      : oracle.query(
          "SELECT COUNT(*) AS schema_objects FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view')",
        ),
    oracle.query("PRAGMA foreign_key_check"),
  ]);
  let integrity = "d1-managed";
  let schemaObjects = 0;
  if (provider === "turso") {
    integrity = String(Object.values(integrityRows[0] ?? {})[0] ?? "").toLowerCase();
    if (integrity !== "ok") {
      throw new Error(`Database integrity_check returned ${integrity || "empty"}.`);
    }
  } else {
    schemaObjects = scalarNumber(integrityRows, "schema_objects");
    if (schemaObjects < 1) throw new Error("D1 load target has no schema objects.");
  }
  if (foreignKeyRows.length !== 0) {
    throw new Error(`Database has ${foreignKeyRows.length} foreign-key violations.`);
  }
  let journalMode = "d1-managed";
  if (provider === "turso") {
    const journalRows = await oracle.query("PRAGMA journal_mode");
    journalMode = String(Object.values(journalRows[0] ?? {})[0] ?? "").toLowerCase();
    if (journalMode !== "mvcc") {
      throw new Error(`Database journal mode is ${journalMode || "empty"}, not mvcc.`);
    }
  }
  return {
    integrity,
    foreignKeyViolations: 0,
    journalMode,
    ...(provider === "d1" ? { schemaObjects } : {}),
  };
}

async function assertLoadTargetPreflight(
  options: LoadOptions,
  oracle: SqlitePortabilityExecutor,
): Promise<LoadTargetIdentity> {
  const sentinelRows = await oracle.query(
    `SELECT target_id, purpose, database_hostname, fixture_namespace
       FROM scalius_loadtest_target`,
  );
  const identity = assertDisposableDatabaseTarget({
    databaseUrl: options.databaseUrl,
    acknowledgedDatabaseHostname: options.acknowledgedDatabaseHostname,
    expectedTargetId: options.targetId,
    acknowledgedTargetId: options.acknowledgedTargetId,
    sentinelRows,
  });

  const fixtureIds = [
    options.fixture.spread.productId,
    options.fixture.hot.productId,
  ];
  if (
    new Set(fixtureIds).size !== fixtureIds.length ||
    fixtureIds.some((id) => !id.startsWith(`${identity.fixtureNamespace}_`))
  ) {
    throw new Error(
      "Load-test fixture product ids must be distinct and namespaced by the target sentinel.",
    );
  }

  const fixtureRows = await oracle.query(
    `SELECT id, slug, is_active, deleted_at
       FROM products
      WHERE id IN (?, ?)
      ORDER BY id`,
    fixtureIds,
  );
  if (fixtureRows.length !== fixtureIds.length) {
    throw new Error("Load-test database is missing a target-specific product fixture.");
  }

  const rowsById = new Map(fixtureRows.map((row) => [String(row.id), row]));
  for (const productId of fixtureIds) {
    const row = rowsById.get(productId);
    const slug = typeof row?.slug === "string" ? row.slug : "";
    if (
      !row ||
      !slug ||
      Number(row.is_active) !== 1 ||
      row.deleted_at !== null
    ) {
      throw new Error("Load-test product fixture is not active and public.");
    }

    const apiResult = await requestJson(
      options,
      "GET",
      `/api/v1/products/${encodeURIComponent(slug)}`,
    );
    const apiProduct = (
      apiResult.raw?.data as Record<string, unknown> | undefined
    )?.product as Record<string, unknown> | undefined;
    if (apiResult.result.status !== 200 || apiProduct?.id !== productId) {
      throw new Error(
        "Load-test Worker does not resolve the target-specific database fixture.",
      );
    }
  }

  return identity;
}

function buildPayload(
  fixture: LoadFixture,
  variant: FixtureVariant,
  notes: string,
  sequence: number,
  checkoutRequestId: string,
): Record<string, unknown> {
  const suffix = String(sequence).padStart(7, "0");
  const phone = `+88017${String(30_000_000 + sequence).slice(-8)}`;
  return {
    checkoutRequestId,
    customerName: `Load Test Buyer ${suffix}`,
    customerPhone: phone,
    customerEmail: null,
    shippingAddress: `Disposable load test address ${suffix}, Bangladesh`,
    city: fixture.cityId,
    zone: fixture.zoneId,
    area: fixture.areaId,
    cityName: null,
    zoneName: null,
    areaName: null,
    notes,
    items: [{
      cartKey: `load:${variant.label}:${suffix}`,
      productId: variant.productId,
      variantId: variant.variantId,
      quantity: 1,
      price: variant.price,
      productName: "Disposable load-test item",
      variantLabel: null,
    }],
    discountAmount: null,
    discountCode: null,
    shippingCharge: fixture.shippingCharge,
    shippingMethodId: fixture.shippingMethodId,
    paymentMethod: "cod",
    inventoryPool: "regular",
  };
}

async function requestJson(
  options: LoadOptions,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ result: SafeHttpResult; raw: Record<string, unknown> | null }> {
  let response: Awaited<ReturnType<typeof loadFetch>>;
  try {
    response = await loadFetch(`${options.apiOrigin}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
      dispatcher: options.dispatcher,
    });
  } catch (error) {
    return {
      result: {
        status: 0,
        orderId: null,
        errorCode: describeLoadTransportError(error),
      },
      raw: null,
    };
  }
  const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
  const data = parsed?.data as Record<string, unknown> | undefined;
  const error = parsed?.error as Record<string, unknown> | undefined;
  const receiptToken = typeof data?.receiptToken === "string" ? data.receiptToken : null;
  const checkoutPhaseMs = parseCheckoutServerTiming(
    response.headers.get("Server-Timing"),
  );
  return {
    result: {
      status: response.status,
      orderId: typeof data?.orderId === "string" ? data.orderId : null,
      errorCode: typeof error?.code === "string" ? error.code : null,
      ...(checkoutPhaseMs ? { checkoutPhaseMs } : {}),
      ...(receiptToken ? { privateProof: { receiptToken } } : {}),
    },
    raw: parsed,
  };
}

function increment(counts: Record<string, number>, key: string | number | null): void {
  const normalized = String(key ?? "none");
  counts[normalized] = (counts[normalized] ?? 0) + 1;
}

function summarizeScenario(
  scenario: string,
  requested: number,
  results: readonly OpenArrivalResult<SafeHttpResult>[],
  elapsedMs: number,
  oracle: Record<string, string | number | boolean>,
  violations: readonly string[] = [],
): ScenarioSummary {
  const statusCounts: Record<string, number> = {};
  const errorCodeCounts: Record<string, number> = {};
  const timings: LoadTimingSample[] = [];
  const phases = new Map<string, number[]>();
  for (const entry of results) {
    increment(statusCounts, entry.value.status);
    if (entry.value.errorCode) increment(errorCodeCounts, entry.value.errorCode);
    timings.push(entry.timing);
    for (const [phase, duration] of Object.entries(entry.value.checkoutPhaseMs ?? {})) {
      const values = phases.get(phase) ?? [];
      values.push(duration);
      phases.set(phase, values);
    }
  }
  return {
    scenario,
    passed: violations.length === 0,
    violations: [...violations],
    requested,
    statusCounts,
    errorCodeCounts,
    serviceLatencyMs: summarizeTimings(timings, "serviceMs"),
    scheduledLatencyMs: summarizeTimings(timings, "scheduledMs"),
    startLagMs: summarizeTimings(timings, "startLagMs"),
    checkoutPhaseLatencyMs: Object.fromEntries(
      [...phases.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
        ([phase, values]) => [
          phase,
          summarizeTimings(
            values.map((value) => ({
              serviceMs: value,
              scheduledMs: value,
              startLagMs: value,
            })),
            "serviceMs",
          ),
        ],
      ),
    ),
    elapsedMs: Math.round(elapsedMs),
    achievedPerSecond: Number((requested / (elapsedMs / 1_000)).toFixed(2)),
    oracle,
  };
}

async function runSmoke(
  options: LoadOptions,
  oracle: SqlitePortabilityExecutor,
  runId: string,
): Promise<ScenarioSummary> {
  const scenario = "smoke";
  const notes = `scalius-load:${runId}:${scenario}`;
  const requestId = `${runId}_${scenario}_0000001`;
  const payload = buildPayload(options.fixture, options.fixture.spread, notes, 1, requestId);
  const cartBody = {
    items: payload.items,
    inventoryPool: payload.inventoryPool,
    city: payload.city,
    zone: payload.zone,
    area: payload.area,
    shippingMethodId: payload.shippingMethodId,
  };
  const startedAt = performance.now();
  const cart = await requestJson(options, "POST", "/api/v1/orders/cart-validation", cartBody);
  if (cart.result.status !== 200 || (cart.raw?.data as Record<string, unknown> | undefined)?.valid !== true) {
    throw new Error(`Cart validation failed with HTTP ${cart.result.status}.`);
  }
  const checkoutStartedAt = performance.now();
  const first = await requestJson(options, "POST", "/api/v1/orders", payload);
  const checkoutElapsedMs = performance.now() - checkoutStartedAt;
  if (first.result.status !== 201 || !first.result.orderId || !first.result.privateProof) {
    throw new Error(`Smoke checkout failed with HTTP ${first.result.status}.`);
  }
  const replay = await requestJson(options, "POST", "/api/v1/orders", payload);
  if (replay.result.status !== 201 || replay.result.orderId !== first.result.orderId) {
    throw new Error("Committed checkout replay did not return the original order.");
  }
  const receipt = await requestJson(
    options,
    "GET",
    `/api/v1/orders/receipt/${encodeURIComponent(first.result.orderId)}`,
    undefined,
    { "X-Receipt-Token": first.result.privateProof.receiptToken },
  );
  const receiptOrder = (receipt.raw?.data as Record<string, unknown> | undefined)?.order as Record<string, unknown> | undefined;
  if (receipt.result.status !== 200 || receiptOrder?.id !== first.result.orderId) {
    throw new Error("Receipt proof did not resolve the created order.");
  }
  const support = await requestJson(
    options,
    "POST",
    `/api/v1/orders/receipt/${encodeURIComponent(first.result.orderId)}/support-requests`,
    {
      token: first.result.privateProof.receiptToken,
      type: "cancel_pre_shipment",
      reason: "Disposable live migration smoke",
      message: "Disposable support request created during the migration verification run.",
    },
  );
  if (support.result.status !== 201) {
    throw new Error(`Support-request smoke failed with HTTP ${support.result.status}.`);
  }
  const { facts, projectionCatchupMs } = await waitForProjectedRunFacts(
    oracle,
    notes,
    { orders: 1, items: 1, attempts: 1 },
    options.timeoutMs,
  );
  if (
    facts.orders !== 1 ||
    facts.items !== 1 ||
    facts.attempts !== 1 ||
    facts.supportRequests !== 1
  ) {
    throw new Error(`Smoke database oracle failed: ${JSON.stringify(facts)}.`);
  }
  const elapsedMs = performance.now() - startedAt;
  const timing = {
    serviceMs: checkoutElapsedMs,
    scheduledMs: checkoutElapsedMs,
    startLagMs: 0,
  };
  return summarizeScenario(
    scenario,
    1,
    [{ value: first.result, timing }],
    elapsedMs,
    {
      ...facts,
      projectionCatchupMs,
      ...(await assertDatabaseHealth(oracle, options.databaseProvider)),
      replay: true,
      receipt: true,
    },
  );
}

async function runIdempotency(
  options: LoadOptions,
  oracle: SqlitePortabilityExecutor,
  runId: string,
): Promise<ScenarioSummary> {
  const scenario = "idempotency";
  const notes = `scalius-load:${runId}:${scenario}`;
  const requestId = `${runId}_${scenario}_shared`;
  const payload = buildPayload(options.fixture, options.fixture.spread, notes, 2, requestId);
  const startedAt = performance.now();
  const results = await runOpenArrival({
    count: options.idempotencyRequests,
    ratePerSecond: 10_000,
    leadInMs: 100,
    async execute() {
      return (await requestJson(options, "POST", "/api/v1/orders", payload)).result;
    },
  });
  const loadElapsedMs = performance.now() - startedAt;
  const bad = results.filter(({ value }) => value.status !== 201 && value.status !== 202);
  if (bad.length > 0) {
    throw new Error(`Idempotency burst returned ${bad.length} responses outside 201/202.`);
  }
  const replay = await requestJson(options, "POST", "/api/v1/orders", payload);
  if (replay.result.status !== 201 || !replay.result.orderId) {
    throw new Error(`Idempotency replay failed with HTTP ${replay.result.status}.`);
  }
  const orderIds = new Set(
    [...results.map(({ value }) => value.orderId), replay.result.orderId].filter(Boolean),
  );
  if (orderIds.size !== 1) throw new Error("Idempotency burst returned more than one order id.");
  const { facts, projectionCatchupMs } = await waitForProjectedRunFacts(
    oracle,
    notes,
    { orders: 1, items: 1, attempts: 1 },
    options.timeoutMs,
  );
  if (facts.orders !== 1 || facts.items !== 1 || facts.attempts !== 1) {
    throw new Error(`Idempotency database oracle failed: ${JSON.stringify(facts)}.`);
  }
  return summarizeScenario(
    scenario,
    options.idempotencyRequests,
    results,
    loadElapsedMs,
    {
      ...facts,
      projectionCatchupMs,
      uniqueOrderIds: orderIds.size,
      ...(await assertDatabaseHealth(oracle, options.databaseProvider)),
    },
  );
}

async function runSpread(
  options: LoadOptions,
  oracle: SqlitePortabilityExecutor,
  runId: string,
): Promise<ScenarioSummary> {
  const scenario = "spread";
  const notes = `scalius-load:${runId}:${scenario}`;
  const before = await readVariantState(oracle, options.fixture.spread.variantId);
  if (before.trackInventory !== 0) throw new Error("Spread-test variant must have inventory tracking disabled.");
  const startedAt = performance.now();
  const results = await runOpenArrival({
    count: options.spreadOrders,
    ratePerSecond: options.spreadRate,
    async execute(sequence) {
      const payload = buildPayload(
        options.fixture,
        options.fixture.spread,
        notes,
        10_000 + sequence,
        `${runId}_${scenario}_${String(sequence).padStart(7, "0")}`,
      );
      return (await requestJson(options, "POST", "/api/v1/orders", payload)).result;
    },
  });
  const loadElapsedMs = performance.now() - startedAt;
  const failures = results.filter(({ value }) => value.status !== 201);
  const violations: string[] = [];
  if (failures.length > 0) {
    const statusCounts: Record<string, number> = {};
    for (const failure of failures) increment(statusCounts, failure.value.status);
    violations.push(
      `${failures.length} orders returned non-201 statuses ${JSON.stringify(statusCounts)}`,
    );
  }
  const accepted = options.spreadOrders - failures.length;
  const { facts, projectionCatchupMs } = await waitForProjectedRunFacts(
    oracle,
    notes,
    { orders: accepted, items: accepted, attempts: accepted },
    options.timeoutMs,
  );
  if (
    facts.orders !== accepted ||
    facts.items !== accepted ||
    facts.attempts !== accepted ||
    facts.movements !== 0
  ) {
    violations.push(`database facts did not match ${accepted} successful checkouts`);
  }
  const after = await readVariantState(oracle, options.fixture.spread.variantId);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    violations.push("untracked spread variant counters changed");
  }
  return summarizeScenario(
    scenario,
    options.spreadOrders,
    results,
    loadElapsedMs,
    {
      ...facts,
      projectionCatchupMs,
      accepted,
      acceptedOrdersPerSecond: Number((accepted / (loadElapsedMs / 1_000)).toFixed(2)),
      failed: failures.length,
      ratePerSecond: options.spreadRate,
      ...(await assertDatabaseHealth(oracle, options.databaseProvider)),
    },
    violations,
  );
}

async function runHot(
  options: LoadOptions,
  oracle: SqlitePortabilityExecutor,
  runId: string,
): Promise<ScenarioSummary> {
  const scenario = "hot";
  const notes = `scalius-load:${runId}:${scenario}`;
  const before = await readVariantState(oracle, options.fixture.hot.variantId);
  const lanesBefore = await readReservationLaneState(oracle, options.fixture.hot.variantId);
  if (before.trackInventory !== 1) throw new Error("Hot-test variant must have inventory tracking enabled.");
  const laneReservedBefore = lanesBefore.reduce(
    (sum, lane) => sum + lane.reservedQuantity,
    0,
  );
  const available = before.stock - before.reservedStock - laneReservedBefore;
  if (available < 1) throw new Error("Hot-test variant has no available regular stock.");
  if (options.hotOrders <= available) {
    throw new Error(`Hot test must submit more than the ${available} available units.`);
  }
  const startedAt = performance.now();
  const results = await runOpenArrival({
    count: options.hotOrders,
    ratePerSecond: options.hotRate,
    async execute(sequence) {
      const payload = buildPayload(
        options.fixture,
        options.fixture.hot,
        notes,
        20_000 + sequence,
        `${runId}_${scenario}_${String(sequence).padStart(7, "0")}`,
      );
      return (await requestJson(options, "POST", "/api/v1/orders", payload)).result;
    },
  });
  const loadElapsedMs = performance.now() - startedAt;
  const accepted = results.filter(({ value }) => value.status === 201).length;
  const unexpected = results.filter(({ value }) => value.status !== 201 && value.status !== 400);
  const violations: string[] = [];
  if (unexpected.length > 0) {
    const statusCounts: Record<string, number> = {};
    for (const entry of unexpected) increment(statusCounts, entry.value.status);
    violations.push(`unexpected response statuses ${JSON.stringify(statusCounts)}`);
  }
  const { facts, projectionCatchupMs } = await waitForProjectedRunFacts(
    oracle,
    notes,
    { orders: accepted, items: accepted, attempts: accepted },
    options.timeoutMs,
  );
  const after = await readVariantState(oracle, options.fixture.hot.variantId);
  const lanesAfter = await readReservationLaneState(oracle, options.fixture.hot.variantId);
  const edgeRows = await oracle.query(
    `SELECT
        CAST(json_extract(edge.value, '$.lane') AS INTEGER) AS lane,
        COUNT(*) AS edge_count,
        COUNT(DISTINCT CAST(json_extract(edge.value, '$.reservedBefore') AS INTEGER)) AS distinct_reserved_before,
        COUNT(DISTINCT CAST(json_extract(edge.value, '$.laneVersionBefore') AS INTEGER)) AS distinct_version_before,
        COALESCE(SUM(CAST(json_extract(edge.value, '$.quantity') AS INTEGER)), 0) AS quantity,
        COALESCE(MIN(CAST(json_extract(edge.value, '$.reservedBefore') AS INTEGER)), 0) AS min_reserved_before,
        COALESCE(MAX(CAST(json_extract(edge.value, '$.reservedAfter') AS INTEGER)), 0) AS max_reserved_after,
        COALESCE(MIN(CAST(json_extract(edge.value, '$.laneVersionBefore') AS INTEGER)), 0) AS min_version_before,
        COALESCE(MAX(CAST(json_extract(edge.value, '$.laneVersionAfter') AS INTEGER)), 0) AS max_version_after
       FROM orders AS checkout_order
       JOIN json_each(checkout_order.checkout_inventory_edges) AS edge ON 1 = 1
      WHERE checkout_order.notes = ?
        AND checkout_order.inventory_authority = 'checkout_lane_v1'
        AND checkout_order.inventory_action = 'reserved'
      GROUP BY CAST(json_extract(edge.value, '$.lane') AS INTEGER)
      ORDER BY lane`,
    [notes],
  );
  const edgeGroups = edgeRows.map((row) => ({
    lane: Number(row.lane),
    edgeCount: Number(row.edge_count),
    distinctReservedBefore: Number(row.distinct_reserved_before),
    distinctVersionBefore: Number(row.distinct_version_before),
    quantity: Number(row.quantity),
    minReservedBefore: Number(row.min_reserved_before),
    maxReservedAfter: Number(row.max_reserved_after),
    minVersionBefore: Number(row.min_version_before),
    maxVersionAfter: Number(row.max_version_after),
  }));
  const beforeByLane = new Map(lanesBefore.map((lane) => [lane.lane, lane]));
  const afterByLane = new Map(lanesAfter.map((lane) => [lane.lane, lane]));
  const edgeContinuityExact = edgeGroups.every((group) => {
    const laneBefore = beforeByLane.get(group.lane) ?? {
      reservedQuantity: 0,
      version: 0,
    };
    const laneAfter = afterByLane.get(group.lane);
    return Boolean(
      laneAfter
      && group.edgeCount === group.quantity
      && group.distinctReservedBefore === group.edgeCount
      && group.distinctVersionBefore === group.edgeCount
      && group.minReservedBefore === laneBefore.reservedQuantity
      && group.maxReservedAfter === laneAfter.reservedQuantity
      && group.minVersionBefore === laneBefore.version
      && group.maxVersionAfter === laneAfter.version
      && laneAfter.reservedQuantity - laneBefore.reservedQuantity === group.quantity
      && laneAfter.version - laneBefore.version === group.edgeCount
    );
  });
  const laneReservedAfter = lanesAfter.reduce(
    (sum, lane) => sum + lane.reservedQuantity,
    0,
  );
  const laneVersionBefore = lanesBefore.reduce((sum, lane) => sum + lane.version, 0);
  const laneVersionAfter = lanesAfter.reduce((sum, lane) => sum + lane.version, 0);
  const laneCapacityAfter = lanesAfter.reduce((sum, lane) => sum + lane.capacity, 0);
  const laneEdgeQuantity = edgeGroups.reduce((sum, group) => sum + group.quantity, 0);
  const terminalRows = await oracle.query(
    `SELECT COUNT(*) AS terminal_count
       FROM checkout_inventory_lane_movements AS movement
       JOIN orders AS checkout_order ON checkout_order.id = movement.order_id
      WHERE checkout_order.notes = ?`,
    [notes],
  );
  const terminalMovements = scalarNumber(terminalRows, "terminal_count");
  if (
    accepted !== available ||
    facts.orders !== accepted ||
    facts.items !== accepted ||
    facts.attempts !== accepted ||
    facts.movements !== 0 ||
    after.stock !== before.stock ||
    after.reservedStock !== before.reservedStock ||
    after.stockVersion !== before.stockVersion ||
    lanesAfter.length !== 2 ||
    lanesAfter.some((lane) => lane.sourceStockVersion !== after.stockVersion) ||
    laneCapacityAfter !== Math.max(laneReservedAfter, after.stock - after.reservedStock) ||
    laneReservedAfter - laneReservedBefore !== accepted ||
    laneVersionAfter - laneVersionBefore !== accepted ||
    laneEdgeQuantity !== accepted ||
    !edgeContinuityExact ||
    terminalMovements !== 0
  ) {
    violations.push("stock, order, or checkout-lane ledger invariants did not match accepted orders");
  }
  return summarizeScenario(
    scenario,
    options.hotOrders,
    results,
    loadElapsedMs,
    {
      ...facts,
      projectionCatchupMs,
      accepted,
      acceptedOrdersPerSecond: Number((accepted / (loadElapsedMs / 1_000)).toFixed(2)),
      rejected: options.hotOrders - accepted,
      availableBefore: available,
      laneReservedBefore,
      laneReservedAfter,
      laneCapacityAfter,
      stockAfter: after.stock,
      stockVersionDelta: after.stockVersion - before.stockVersion,
      checkoutLaneEdgeQuantity: laneEdgeQuantity,
      checkoutLaneVersionDelta: laneVersionAfter - laneVersionBefore,
      legacyLedgerMovements: facts.movements,
      terminalLaneMovements: terminalMovements,
      edgeContinuityExact,
      ratePerSecond: options.hotRate,
      ...(await assertDatabaseHealth(oracle, options.databaseProvider)),
    },
    violations,
  );
}

export async function runLiveCheckoutLoad(options: LoadOptions): Promise<{
  runId: string;
  targetHostname: string;
  targetId: string;
  databaseHostname: string;
  clientConnections: number;
  scenarios: ScenarioSummary[];
}> {
  if (options.databaseProvider === "turso") {
    if (!options.tursoBilling) {
      throw new Error("Turso load-test billing isolation and budgets are required.");
    }
    await preflightTursoLoadBudget({
      organization: options.tursoBilling.organization,
      platformToken: options.tursoBilling.platformToken,
      rowsReadBudget: options.tursoBilling.rowsReadBudget,
      rowsWrittenBudget: options.tursoBilling.rowsWrittenBudget,
      allowUsageOverage: options.tursoBilling.allowUsageOverage,
    });
  }
  const runId = `lt_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  if (options.clientConnections > 4_096) {
    throw new Error("Load-test client connections must not exceed 4096.");
  }
  const dispatcher = new Agent({
    connections: options.clientConnections,
    connect: { timeout: Math.min(options.timeoutMs, 60_000) },
  });
  const executionOptions: LoadOptions = { ...options, dispatcher };
  const oracle = createLoadOracle(executionOptions);
  const scenarios: ScenarioSummary[] = [];
  try {
    await assertDatabaseHealth(oracle, executionOptions.databaseProvider);
    let identity = await assertLoadTargetPreflight(executionOptions, oracle);
    if (executionOptions.scenario === "smoke" || executionOptions.scenario === "all") {
      identity = await assertLoadTargetPreflight(executionOptions, oracle);
      scenarios.push(await runSmoke(executionOptions, oracle, runId));
    }
    if (executionOptions.scenario === "idempotency" || executionOptions.scenario === "all") {
      identity = await assertLoadTargetPreflight(executionOptions, oracle);
      scenarios.push(await runIdempotency(executionOptions, oracle, runId));
    }
    if (executionOptions.scenario === "spread" || executionOptions.scenario === "all") {
      identity = await assertLoadTargetPreflight(executionOptions, oracle);
      scenarios.push(await runSpread(executionOptions, oracle, runId));
    }
    if (executionOptions.scenario === "hot" || executionOptions.scenario === "all") {
      identity = await assertLoadTargetPreflight(executionOptions, oracle);
      scenarios.push(await runHot(executionOptions, oracle, runId));
    }
    identity = await assertLoadTargetPreflight(executionOptions, oracle);
    return {
      runId,
      targetHostname: new URL(options.apiOrigin).hostname,
      targetId: identity.targetId,
      databaseHostname: identity.databaseHostname,
      clientConnections: executionOptions.clientConnections,
      scenarios,
    };
  } finally {
    await Promise.all([oracle.close?.(), dispatcher.close()]);
  }
}

async function main(): Promise<void> {
  const result = await runLiveCheckoutLoad(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.scenarios.some((scenario) => !scenario.passed)) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[live-checkout-load] ${message}\n`);
    process.exitCode = 1;
  });
}
