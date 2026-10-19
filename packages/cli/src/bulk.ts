import { emit, profileFor, readPage, write, type OutputOptions } from "./agent.js";
import { CliError } from "./errors.js";
import { getIndexedOperations } from "./openapi.js";
import { writeDiagnostic } from "./output.js";
import type { IndexedOperation, Runtime, StructuredInput } from "./types.js";

// `scalius bulk <kind>`: the reviewed bulk operations (prices, stock, tags,
// status, publish). Small sets run in the request; large ones become a
// durable bulk run, which `--wait` follows to the end. Every bulk change
// takes a dry run first and the merchant's approval when it is gated.

export const BULK_KINDS = {
  prices: "variants.bulk_set_prices",
  stock: "variants.bulk_set_stock",
  tags: "customers.bulk_tag",
  status: "products.bulk_set_status",
  publish: "products.bulk_publish",
} as const;
export type BulkKind = keyof typeof BULK_KINDS;

const RUN_READS = ["dashboard.resources.bulk_runs.get", "dashboard.bulk_runs.get"];
const TERMINAL = new Set(["completed", "succeeded", "failed", "cancelled", "canceled", "partial"]);
const WAIT_LIMIT_MS = 15 * 60 * 1_000;
const POLL_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The bulk operation this store offers for a kind, if its API has it yet. */
export function bulkOperation(operations: readonly IndexedOperation[], kind: BulkKind): IndexedOperation | undefined {
  const suffix = BULK_KINDS[kind];
  return operations.find((operation) => operation.id === `dashboard.resources.${suffix}`)
    ?? operations.find((operation) => operation.id === `dashboard.${suffix}`);
}

function parseJsonFlag(name: string, value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CliError(2, "invalid_json", `--${name} must be JSON.`);
  }
}

export interface BulkOptions {
  input?: StructuredInput;
  ids?: string;
  filter?: string;
  set?: string;
  dryRun: boolean;
  yes: boolean;
  confirmToken?: string;
  wait: boolean;
}

export function bulkBody(options: BulkOptions): StructuredInput {
  if (options.input && (options.input.body !== undefined || options.input.path || options.input.query)) {
    if (options.ids || options.filter || options.set) {
      throw new CliError(2, "invalid_input", "Pass either --input or --ids/--filter/--set, not both.");
    }
    return options.input;
  }
  const ids = options.ids?.split(",").map((id) => id.trim()).filter(Boolean);
  const filter = parseJsonFlag("filter", options.filter);
  const set = parseJsonFlag("set", options.set);
  if (!ids?.length && filter === undefined) throw new CliError(2, "invalid_input", "Choose the records with --ids or --filter.");
  if (set === undefined) throw new CliError(2, "invalid_input", "Say what to change with --set (see scalius describe for its fields).");
  return { body: { ...(ids?.length ? { ids } : {}), ...(filter === undefined ? {} : { filter }), set } };
}

export async function bulk(runtime: Runtime, output: OutputOptions, kind: BulkKind, options: BulkOptions): Promise<number> {
  const profile = await profileFor(runtime, "dashboard", output.profile);
  const { operations } = await getIndexedOperations(runtime, profile);
  const operation = bulkOperation(operations, kind);
  if (!operation) {
    throw new CliError(5, "bulk_unavailable", `This store's API has no reviewed bulk ${kind} operation yet.`, undefined, {
      hint: `Update the store's API, or run the change per record: scalius search "${kind}" and scalius write with --dry-run first.`,
    });
  }
  const input = bulkBody(options);
  const outcome = await write(runtime, output, operation.id, {
    input,
    dryRun: options.dryRun,
    yes: options.yes,
    confirmToken: options.confirmToken,
    print: !options.wait || options.dryRun,
  });
  if (!options.wait || options.dryRun) return outcome.code;
  const data = isRecord(outcome.envelope.data) ? outcome.envelope.data : {};
  const runId = typeof data.runId === "string" ? data.runId : isRecord(data.run) && typeof data.run.id === "string" ? data.run.id : undefined;
  if (!runId) {
    emit(runtime, output, outcome.envelope);
    return 0;
  }
  const runRead = RUN_READS.map((id) => operations.find((candidate) => candidate.id === id)).find(Boolean);
  if (!runRead) throw new CliError(5, "bulk_run_unreadable", `Bulk run ${runId} started, but this API cannot report its progress.`);
  const started = runtime.now();
  while (runtime.now() - started < WAIT_LIMIT_MS) {
    await runtime.sleep(POLL_MS);
    const result = await readPage(runtime, profile, "dashboard", { operationId: runRead.id, input: { path: { id: runId } } });
    const run = isRecord(result.value.data) ? result.value.data : {};
    const status = typeof run.status === "string" ? run.status : "";
    if (runtime.stderr.isTTY) writeDiagnostic(runtime, `Bulk run ${runId}: ${status || "running"}${typeof run.processed === "number" ? ` (${run.processed} done)` : ""}`);
    if (TERMINAL.has(status)) {
      emit(runtime, output, { ok: status !== "failed", data: run, meta: { operationId: runRead.id, runId } });
      return status === "failed" ? 8 : 0;
    }
  }
  throw new CliError(7, "bulk_run_timeout", `Bulk run ${runId} is still running.`, undefined, {
    retryable: true,
    hint: `Check it later with: scalius read ${runRead.id} --input '{"path":{"id":"${runId}"}}'`,
  });
}
