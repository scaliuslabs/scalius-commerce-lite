import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  createTursoPortabilityExecutor,
  type SqlitePortabilityExecutor,
} from "../src/portability";
import {
  assertDisposableLoadTarget,
  runOpenArrival,
  summarizeTimings,
  type LoadTimingSample,
  type OpenArrivalResult,
} from "./live-checkout-load-core";

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
  apiOrigin: string;
  databaseUrl: string;
  databaseToken: string;
  fixture: LoadFixture;
  scenario: "smoke" | "idempotency" | "spread" | "hot" | "all";
  idempotencyRequests: number;
  spreadOrders: number;
  spreadRate: number;
  hotOrders: number;
  hotRate: number;
  timeoutMs: number;
}

interface SafeHttpResult {
  status: number;
  orderId: string | null;
  errorCode: string | null;
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
  elapsedMs: number;
  achievedPerSecond: number;
  oracle: Record<string, string | number | boolean>;
}

interface VariantState {
  stock: number;
  reservedStock: number;
  stockVersion: number;
  trackInventory: number;
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

function parseArguments(argv: readonly string[]): LoadOptions {
  let scenario: LoadOptions["scenario"] = "all";
  let idempotencyRequests = 25;
  let spreadOrders = 20;
  let spreadRate = 5;
  let hotOrders = 60;
  let hotRate = 30;
  let timeoutMs = 30_000;

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
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
    }
  }

  const apiUrl = requiredEnvironment("LOADTEST_API_URL");
  const apiOrigin = assertDisposableLoadTarget(
    apiUrl,
    requiredEnvironment("LOADTEST_ACK_HOST"),
  ).origin;
  const databaseUrl = requiredEnvironment("TURSO_DATABASE_URL");
  const parsedDatabaseUrl = new URL(databaseUrl);
  if (parsedDatabaseUrl.username || parsedDatabaseUrl.password) {
    throw new Error("TURSO_DATABASE_URL must not contain credentials.");
  }

  return {
    apiOrigin,
    databaseUrl,
    databaseToken: requiredEnvironment("TURSO_AUTH_TOKEN"),
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
  };
}

function scalarNumber(rows: readonly Record<string, unknown>[], key: string): number {
  const value = Number(rows[0]?.[key]);
  if (!Number.isFinite(value)) throw new Error(`Database oracle did not return numeric ${key}.`);
  return value;
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

async function assertDatabaseHealth(
  oracle: SqlitePortabilityExecutor,
): Promise<Record<string, string | number>> {
  const [integrityRows, foreignKeyRows, journalRows] = await Promise.all([
    oracle.query("PRAGMA integrity_check"),
    oracle.query("PRAGMA foreign_key_check"),
    oracle.query("PRAGMA journal_mode"),
  ]);
  const integrity = String(Object.values(integrityRows[0] ?? {})[0] ?? "").toLowerCase();
  const journalMode = String(Object.values(journalRows[0] ?? {})[0] ?? "").toLowerCase();
  if (integrity !== "ok") throw new Error(`Database integrity_check returned ${integrity || "empty"}.`);
  if (foreignKeyRows.length !== 0) {
    throw new Error(`Database has ${foreignKeyRows.length} foreign-key violations.`);
  }
  if (journalMode !== "mvcc") throw new Error(`Database journal mode is ${journalMode || "empty"}, not mvcc.`);
  return { integrity, foreignKeyViolations: 0, journalMode };
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
  let response: Response;
  try {
    response = await fetch(`${options.apiOrigin}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    const description = error instanceof Error ? error.name : "request_error";
    return {
      result: { status: 0, orderId: null, errorCode: description },
      raw: null,
    };
  }
  const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
  const data = parsed?.data as Record<string, unknown> | undefined;
  const error = parsed?.error as Record<string, unknown> | undefined;
  const receiptToken = typeof data?.receiptToken === "string" ? data.receiptToken : null;
  return {
    result: {
      status: response.status,
      orderId: typeof data?.orderId === "string" ? data.orderId : null,
      errorCode: typeof error?.code === "string" ? error.code : null,
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
  for (const entry of results) {
    increment(statusCounts, entry.value.status);
    if (entry.value.errorCode) increment(errorCodeCounts, entry.value.errorCode);
    timings.push(entry.timing);
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
  const facts = await readRunFacts(oracle, notes);
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
    { ...facts, ...(await assertDatabaseHealth(oracle)), replay: true, receipt: true },
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
  const facts = await readRunFacts(oracle, notes);
  if (facts.orders !== 1 || facts.items !== 1 || facts.attempts !== 1) {
    throw new Error(`Idempotency database oracle failed: ${JSON.stringify(facts)}.`);
  }
  return summarizeScenario(
    scenario,
    options.idempotencyRequests,
    results,
    loadElapsedMs,
    { ...facts, uniqueOrderIds: orderIds.size, ...(await assertDatabaseHealth(oracle)) },
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
  const facts = await readRunFacts(oracle, notes);
  const accepted = options.spreadOrders - failures.length;
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
      accepted,
      failed: failures.length,
      ratePerSecond: options.spreadRate,
      ...(await assertDatabaseHealth(oracle)),
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
  if (before.trackInventory !== 1) throw new Error("Hot-test variant must have inventory tracking enabled.");
  const available = before.stock - before.reservedStock;
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
  const facts = await readRunFacts(oracle, notes);
  const after = await readVariantState(oracle, options.fixture.hot.variantId);
  const ledgerRows = await oracle.query(
    `SELECT COUNT(*) AS movement_count,
            COUNT(DISTINCT im.stock_version_after) AS distinct_versions,
            COALESCE(SUM(im.reserved_stock_delta), 0) AS reserved_delta,
            COALESCE(MIN(im.ledger_version), 0) AS min_ledger_version
       FROM inventory_movements im
       JOIN orders o ON o.id = im.order_id
      WHERE o.notes = ?`,
    [notes],
  );
  const ledger = {
    movements: scalarNumber(ledgerRows, "movement_count"),
    distinctVersions: scalarNumber(ledgerRows, "distinct_versions"),
    reservedDelta: scalarNumber(ledgerRows, "reserved_delta"),
    minLedgerVersion: scalarNumber(ledgerRows, "min_ledger_version"),
  };
  if (
    accepted !== available ||
    facts.orders !== accepted ||
    facts.items !== accepted ||
    after.stock !== before.stock ||
    after.reservedStock - before.reservedStock !== accepted ||
    after.stockVersion - before.stockVersion !== accepted ||
    after.reservedStock > after.stock ||
    ledger.movements !== accepted ||
    ledger.distinctVersions !== accepted ||
    ledger.reservedDelta !== accepted ||
    ledger.minLedgerVersion !== 2
  ) {
    violations.push("stock, order, or ledger-v2 invariants did not match accepted orders");
  }
  return summarizeScenario(
    scenario,
    options.hotOrders,
    results,
    loadElapsedMs,
    {
      ...facts,
      accepted,
      rejected: options.hotOrders - accepted,
      availableBefore: available,
      reservedAfter: after.reservedStock,
      stockAfter: after.stock,
      stockVersionDelta: after.stockVersion - before.stockVersion,
      ledgerV2Movements: ledger.movements,
      ratePerSecond: options.hotRate,
      ...(await assertDatabaseHealth(oracle)),
    },
    violations,
  );
}

export async function runLiveCheckoutLoad(options: LoadOptions): Promise<{
  runId: string;
  targetHostname: string;
  scenarios: ScenarioSummary[];
}> {
  const runId = `lt_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const oracle = createTursoPortabilityExecutor({
    url: options.databaseUrl,
    authToken: options.databaseToken,
  });
  const scenarios: ScenarioSummary[] = [];
  try {
    await assertDatabaseHealth(oracle);
    if (options.scenario === "smoke" || options.scenario === "all") {
      scenarios.push(await runSmoke(options, oracle, runId));
    }
    if (options.scenario === "idempotency" || options.scenario === "all") {
      scenarios.push(await runIdempotency(options, oracle, runId));
    }
    if (options.scenario === "spread" || options.scenario === "all") {
      scenarios.push(await runSpread(options, oracle, runId));
    }
    if (options.scenario === "hot" || options.scenario === "all") {
      scenarios.push(await runHot(options, oracle, runId));
    }
    return {
      runId,
      targetHostname: new URL(options.apiOrigin).hostname,
      scenarios,
    };
  } finally {
    await oracle.close?.();
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
