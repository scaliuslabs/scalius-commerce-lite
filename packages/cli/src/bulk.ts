import { emit, profileFor, readPage, write, type OutputOptions } from "./agent.js";
import { CliError } from "./errors.js";
import { getIndexedOperations } from "./openapi.js";
import { writeDiagnostic } from "./output.js";
import type { IndexedOperation, Runtime, StructuredInput } from "./types.js";

// `scalius bulk <kind>`: the store's bulk operations (prices, stock, tags,
// status, publish; apps/api bulk-runs/inputs.ts). Friendly flags build the
// operation's exact body; --input sends a raw body instead. A run of up to
// 250 items finishes in its request (the run is `done`); a larger one answers
// `running`, and --wait follows `bulk_runs.get` by the run's `data.id`.

export const BULK_KINDS = {
  prices: "variants.bulk_set_prices",
  stock: "variants.bulk_set_stock",
  tags: "customers.bulk_tag",
  status: "products.bulk_set_status",
  publish: "products.bulk_publish",
} as const;
export type BulkKind = keyof typeof BULK_KINDS;

const RUN_READ = "dashboard.resources.bulk_runs.get";
const WAIT_LIMIT_MS = 15 * 60 * 1_000;
const POLL_MS = 2_000;

/** The product list filter prices, status and publish take (strings), and the customer filter tags take. */
const PRODUCT_FILTER_KEYS = { search: "string", category: "string", status: "string", salesChannel: "string" } as const;
const CUSTOMER_FILTER_KEYS = { tag: "string", minOrders: "number", maxOrders: "number" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The bulk operation this store offers for a kind, if its API has it yet. */
export function bulkOperation(operations: readonly IndexedOperation[], kind: BulkKind): IndexedOperation | undefined {
  return operations.find((operation) => operation.id === `dashboard.resources.${BULK_KINDS[kind]}`);
}

export interface BulkOptions {
  input?: StructuredInput;
  ids?: string;
  filter?: string;
  /** prices: set every price to this amount (minor units). */
  set?: string;
  /** prices: change every price by this percent. */
  percent?: string;
  /** prices: add (negative: take off) this many minor units. */
  amount?: string;
  /** stock: `variantId=quantity,...` */
  items?: string;
  /** stock: the quantity for every --ids SKU. */
  quantity?: string;
  location?: string;
  reason?: string;
  /** tags: comma-separated tags. */
  add?: string;
  remove?: string;
  /** status: active | draft. */
  status?: string;
  /** publish: comma-separated sales channel ids. */
  channels?: string;
  /** publish: publish | unpublish. */
  action?: string;
  dryRun: boolean;
  yes: boolean;
  confirmToken?: string;
  wait: boolean;
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function invalid(message: string): CliError {
  return new CliError(2, "invalid_input", message);
}

function numberFlag(flag: string, value: string, integer: boolean): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    throw invalid(`--${flag} must be ${integer ? "a whole number" : "a number"}, got '${value}'.`);
  }
  return parsed;
}

/** `--filter`: a JSON object, or `key=value,key=value` over the kind's filter keys. */
function parseFilter(value: string, keys: Record<string, "string" | "number">): Record<string, unknown> {
  const allowed = Object.keys(keys).join(", ");
  let parsed: Record<string, unknown> = {};
  if (value.trim().startsWith("{")) {
    try {
      const json = JSON.parse(value) as unknown;
      if (!isRecord(json)) throw new Error("not an object");
      parsed = json;
    } catch {
      throw invalid("--filter JSON must be an object.");
    }
  } else {
    for (const pair of value.split(/,(?=\s*[A-Za-z]+=)/)) {
      const at = pair.indexOf("=");
      if (at < 1) throw invalid(`--filter wants key=value pairs (${allowed}), got '${pair.trim()}'.`);
      const key = pair.slice(0, at).trim();
      const text = pair.slice(at + 1).trim();
      parsed[key] = keys[key] === "number" ? numberFlag(`filter ${key}`, text, true) : text;
    }
  }
  for (const key of Object.keys(parsed)) {
    if (!(key in keys)) throw invalid(`Unknown filter '${key}'. This bulk change filters by: ${allowed}.`);
  }
  if (Object.keys(parsed).length === 0) throw invalid("--filter is empty.");
  return parsed;
}

function selection(options: BulkOptions, filterKeys: Record<string, "string" | "number">, idsName: string): { ids: string[]; filter?: Record<string, unknown> } {
  const ids = list(options.ids);
  if (ids.length > 0 && options.filter !== undefined) throw invalid("Choose the records with --ids or --filter, not both.");
  if (ids.length === 0 && options.filter === undefined) throw invalid(`Choose the records with --ids (${idsName}) or --filter.`);
  return { ids, ...(options.filter === undefined ? {} : { filter: parseFilter(options.filter, filterKeys) }) };
}

function priceChange(options: BulkOptions): Record<string, unknown> {
  const chosen = [options.set, options.percent, options.amount].filter((value) => value !== undefined);
  if (chosen.length !== 1) throw invalid("Say how to change the prices with exactly one of --set <minor units>, --percent <n> or --amount <minor units>.");
  if (options.set !== undefined) {
    const amountMinor = numberFlag("set", options.set, true);
    if (amountMinor < 1) throw invalid("--set must be a price above 0.");
    return { mode: "set", amountMinor };
  }
  if (options.percent !== undefined) return { mode: "percent", percent: numberFlag("percent", options.percent, false) };
  const amountMinor = numberFlag("amount", options.amount!, true);
  if (amountMinor === 0) throw invalid("--amount must not be 0.");
  return { mode: "amount", amountMinor };
}

function stockItems(options: BulkOptions): Array<Record<string, unknown>> {
  if (options.filter !== undefined) throw invalid("Stock counts take SKUs by --ids or --items, not --filter.");
  if (options.items !== undefined) {
    if (options.ids || options.quantity !== undefined) throw invalid("Pass either --items, or --ids with --quantity.");
    return list(options.items).map((pair) => {
      const at = pair.lastIndexOf("=");
      if (at < 1) throw invalid(`--items wants variantId=quantity pairs, got '${pair}'.`);
      return { variantId: pair.slice(0, at).trim(), quantity: numberFlag("items quantity", pair.slice(at + 1), true) };
    });
  }
  const ids = list(options.ids);
  if (ids.length === 0 || options.quantity === undefined) throw invalid("Say which SKUs and counts: --items var_1=20,var_2=0, or --ids var_1,var_2 --quantity 0.");
  const quantity = numberFlag("quantity", options.quantity, true);
  return ids.map((variantId) => ({ variantId, quantity }));
}

function choice<T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw invalid(`--${flag} must be ${allowed.join(" or ")}.`);
  return value as T;
}

function bodyFor(kind: BulkKind, options: BulkOptions): Record<string, unknown> {
  switch (kind) {
    case "prices": {
      const { ids, filter } = selection(options, PRODUCT_FILTER_KEYS, "SKU ids");
      return { ...(filter ? { filter } : { variants: ids.map((id) => ({ id })) }), change: priceChange(options) };
    }
    case "stock": {
      const items = stockItems(options);
      return { ...(options.location ? { locationId: options.location } : {}), items, ...(options.reason ? { reason: options.reason } : {}) };
    }
    case "tags": {
      const { ids, filter } = selection(options, CUSTOMER_FILTER_KEYS, "customer ids");
      const add = list(options.add);
      const remove = list(options.remove);
      if (add.length === 0 && remove.length === 0) throw invalid("Say which tags to change with --add and/or --remove.");
      return { ...(filter ? { filter } : { customerIds: ids }), ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
    }
    case "status": {
      const { ids, filter } = selection(options, PRODUCT_FILTER_KEYS, "product ids");
      return { ...(filter ? { filter } : { products: ids.map((id) => ({ id })) }), status: choice("status", options.status, ["active", "draft"]) };
    }
    case "publish": {
      const { ids, filter } = selection(options, PRODUCT_FILTER_KEYS, "product ids");
      const channelIds = list(options.channels);
      if (channelIds.length === 0) throw invalid("Say which sales channels with --channels.");
      return { ...(filter ? { filter } : { productIds: ids }), channelIds, action: choice("action", options.action, ["publish", "unpublish"]) };
    }
  }
}

const FRIENDLY_FLAGS = ["ids", "filter", "set", "percent", "amount", "items", "quantity", "location", "reason", "add", "remove", "status", "channels", "action"] as const;

/** The exact `{body}` the kind's operation takes: from the flags, or the raw --input. */
export function bulkBody(kind: BulkKind, options: BulkOptions): StructuredInput {
  if (options.input) {
    const used = FRIENDLY_FLAGS.filter((flag) => options[flag] !== undefined);
    if (used.length > 0) throw invalid(`Pass either --input or the friendly flags, not both (got --${used.join(", --")}).`);
    if (options.input.body === undefined || options.input.path || options.input.query) throw invalid("--input for a bulk change is {\"body\": {...}} only.");
    if (options.dryRun && isRecord(options.input.body)) return { body: { ...options.input.body, dryRun: true } };
    return options.input;
  }
  const body = bodyFor(kind, options);
  return { body: options.dryRun ? { ...body, dryRun: true } : body };
}

function runIdOf(data: unknown): string | undefined {
  return isRecord(data) && typeof data.id === "string" ? data.id : undefined;
}

export async function bulk(runtime: Runtime, output: OutputOptions, kind: BulkKind, options: BulkOptions): Promise<number> {
  const profile = await profileFor(runtime, "dashboard", output.profile);
  const { operations } = await getIndexedOperations(runtime, profile);
  const operation = bulkOperation(operations, kind);
  if (!operation) {
    throw new CliError(5, "bulk_unavailable", `This store's API has no bulk ${kind} operation yet.`, undefined, {
      hint: `Update the store's API, or run the change per record: scalius search "${kind}" and scalius write with --dry-run first.`,
    });
  }
  const input = bulkBody(kind, options);
  const outcome = await write(runtime, output, operation.id, {
    input,
    dryRun: options.dryRun,
    yes: options.yes,
    confirmToken: options.confirmToken,
    print: !options.wait || options.dryRun,
  });
  if (options.dryRun) return outcome.code;

  const run = isRecord(outcome.envelope.data) ? outcome.envelope.data : {};
  const runId = runIdOf(run);
  const running = run.status === "running";
  if (!options.wait || !runId || !running) {
    if (options.wait) emit(runtime, output, outcome.envelope);
    else if (running && runId) writeDiagnostic(runtime, `Run ${runId} is still going on the server. Follow it with: scalius read ${RUN_READ} --input '{"path":{"id":"${runId}"}}'`);
    return run.status === "failed" ? 8 : 0;
  }

  const runRead = operations.find((candidate) => candidate.id === RUN_READ);
  if (!runRead) throw new CliError(5, "bulk_run_unreadable", `Bulk run ${runId} started, but this API cannot report its progress.`);
  const started = runtime.now();
  while (runtime.now() - started < WAIT_LIMIT_MS) {
    await runtime.sleep(POLL_MS);
    const result = await readPage(runtime, profile, "dashboard", { operationId: runRead.id, input: { path: { id: runId } } });
    const current = isRecord(result.value.data) ? result.value.data : {};
    const status = typeof current.status === "string" ? current.status : "";
    if (runtime.stderr.isTTY) writeDiagnostic(runtime, `Bulk run ${runId}: ${status || "running"}${typeof current.processed === "number" ? ` (${current.processed} of ${String(current.total ?? "?")} done)` : ""}`);
    if (status === "done" || status === "failed") {
      emit(runtime, output, { ok: status !== "failed", data: current, meta: { operationId: runRead.id, runId } });
      return status === "failed" ? 8 : 0;
    }
  }
  throw new CliError(7, "bulk_run_timeout", `Bulk run ${runId} is still running.`, undefined, {
    retryable: true,
    hint: `Check it later with: scalius read ${runRead.id} --input '{"path":{"id":"${runId}"}}'`,
  });
}
