import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { emit, profileFor, type OutputOptions } from "./agent.js";
import { CliError } from "./errors.js";
import { bearerHeaders, fetchWithNetworkErrors, responseError } from "./http.js";
import { findOperation, getIndexedOperations } from "./openapi.js";
import { buildPath, serializeQuery, validateArtifactResponse, validateQuery } from "./operations.js";
import { writeDiagnostic } from "./output.js";
import type { IndexedOperation, ResolvedProfile, Runtime } from "./types.js";

// `scalius export <kind> --out file`: the reviewed CSV exports, saved
// atomically. Paged exports (products, inventory) follow
// X-Export-Next-Cursor and join the pages into one file with one header.

export const EXPORT_KINDS = {
  orders: { operationId: "dashboard.orders.export", since: "startDate", until: "endDate", paged: false },
  customers: { operationId: "dashboard.customers.export", paged: false },
  products: { operationId: "dashboard.export.products", paged: true },
  inventory: { operationId: "dashboard.export.inventory", paged: true },
  report: { operationId: "dashboard.reports.export", since: "from", until: "to", paged: false },
} as const satisfies Record<string, { operationId: string; since?: string; until?: string; paged: boolean }>;
export type ExportKind = keyof typeof EXPORT_KINDS;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGES = 2_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export interface ExportOptions {
  out: string;
  since?: string;
  until?: string;
  report?: string;
  query?: Record<string, unknown>;
  maxRows?: number;
  overwrite: boolean;
}

function exportQuery(operation: IndexedOperation, kind: ExportKind, options: ExportOptions): Record<string, unknown> {
  const spec = EXPORT_KINDS[kind] as { since?: string; until?: string };
  const query: Record<string, unknown> = { ...(options.query ?? {}) };
  for (const [flag, value, name] of [["--since", options.since, spec.since], ["--until", options.until, spec.until]] as const) {
    if (value === undefined) continue;
    if (!name) throw new CliError(2, "invalid_input", `${flag} does not apply to ${kind} exports.`);
    if (!DATE.test(value)) throw new CliError(2, "invalid_date", `${flag} takes a store-calendar date: YYYY-MM-DD.`);
    query[name] = value;
  }
  if (options.maxRows !== undefined) query.maxRows = options.maxRows;
  validateQuery(operation, query);
  return query;
}

async function fetchPage(runtime: Runtime, profile: ResolvedProfile, operation: IndexedOperation, path: Record<string, unknown>, query: Record<string, unknown>) {
  const relative = `${buildPath(operation, { path })}${serializeQuery(query)}`;
  const url = new URL(relative, `${profile.server}/api/v1/`);
  if (url.origin !== profile.server || !url.pathname.startsWith("/api/v1/")) {
    throw new CliError(8, "invalid_openapi", "Server contract attempted to escape the configured API origin.");
  }
  const response = await fetchWithNetworkErrors(runtime, url.toString(), {
    method: operation.method,
    headers: bearerHeaders(profile.token!),
    redirect: "error",
    signal: runtime.signal,
  });
  if (!response.ok) throw await responseError(response, `Export '${operation.id}' failed.`);
  validateArtifactResponse(response, operation.agent.artifactOutput!);
  return response;
}

export async function exportArtifact(runtime: Runtime, output: OutputOptions, kind: ExportKind, options: ExportOptions): Promise<void> {
  const spec = EXPORT_KINDS[kind];
  const profile = await profileFor(runtime, "dashboard", output.profile);
  const { operations } = await getIndexedOperations(runtime, profile);
  const operation = findOperation(operations, spec.operationId);
  if (!operation.agent.artifactOutput) throw new CliError(8, "invalid_openapi", `${operation.id} does not declare a file export.`);
  const path: Record<string, unknown> = {};
  if (kind === "report") {
    if (!options.report) throw new CliError(2, "invalid_input", "Report exports need --report <reportId> (scalius read dashboard.reports.list).");
    path.reportId = options.report;
  }
  const query = exportQuery(operation, kind, options);
  const destination = resolve(options.out);
  if (!options.overwrite && await stat(destination).then(() => true, () => false)) {
    throw new CliError(2, "output_exists", `Output file already exists: ${destination} (use --overwrite).`);
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let bytes = 0;
  let pages = 0;
  let after: string | undefined;
  try {
    do {
      const pageQuery = spec.paged && after ? { ...query, after, header: "false" } : query;
      const response = await fetchPage(runtime, profile, operation, path, pageQuery);
      const reader = response.body!.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_TOTAL_BYTES) throw new CliError(8, "artifact_too_large", "The export is larger than 512 MiB.");
        await handle.write(chunk.value);
      }
      pages += 1;
      after = spec.paged ? response.headers.get("X-Export-Next-Cursor") ?? undefined : undefined;
      if (after && runtime.stderr.isTTY) writeDiagnostic(runtime, `Exported page ${pages}...`);
    } while (after && pages < MAX_PAGES);
    if (bytes < 1) throw new CliError(8, "invalid_artifact_response", "The export is empty.");
    await handle.sync();
    await handle.close();
    if (options.overwrite) {
      await rename(temporary, destination);
    } else {
      await link(temporary, destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") throw new CliError(2, "output_exists", `Output file already exists: ${destination}`);
        throw error;
      });
    }
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  emit(runtime, output, {
    ok: true,
    data: { kind, savedTo: destination, bytes, pages },
    meta: { operationId: operation.id },
  }, () => `Saved ${kind} export to ${destination} (${bytes} bytes${pages > 1 ? `, ${pages} pages` : ""}).`);
}
