import type { OutputMode, Runtime } from "./types.js";
import type { CliError } from "./errors.js";

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compactJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** JSON whenever stdout is not a terminal (an agent or a pipe); human text on a terminal. */
export function resolveOutputMode(runtime: Runtime, explicit?: string): OutputMode {
  if (explicit === "json" || explicit === "human") return explicit;
  return runtime.stdout.isTTY ? "human" : "json";
}

export function writeResult(runtime: Runtime, mode: OutputMode, value: unknown, human?: string): void {
  if (mode === "json") {
    runtime.stdout.write(compactJson(value));
    return;
  }
  runtime.stdout.write(human ? `${human}\n` : prettyJson(value));
}

/** One NDJSON line per value. */
export function writeLines(runtime: Runtime, values: readonly unknown[]): void {
  for (const value of values) runtime.stdout.write(compactJson(value));
}

/** jq-style raw output: strings print as text, everything else as compact JSON. */
export function writeRawValues(runtime: Runtime, values: readonly unknown[]): void {
  for (const value of values) {
    runtime.stdout.write(typeof value === "string" ? `${value}\n` : compactJson(value));
  }
}

export function writeDiagnostic(runtime: Runtime, message: string): void {
  runtime.stderr.write(`${message}\n`);
}

export function errorEnvelope(error: CliError): Record<string, unknown> {
  const { status, retryable, hint, current, field, requestId, retryAfterMs } = error.envelope;
  return {
    ok: false,
    error: {
      code: error.errorCode,
      message: error.message,
      ...(status === undefined ? {} : { status }),
      ...(retryable === undefined ? {} : { retryable }),
      ...(hint === undefined ? {} : { hint }),
      ...(current === undefined ? {} : { current }),
      ...(field === undefined || field === null ? {} : { field }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

export function writeError(runtime: Runtime, mode: OutputMode, error: CliError): void {
  if (mode === "json") {
    runtime.stderr.write(compactJson(errorEnvelope(error)));
    return;
  }
  runtime.stderr.write(`Error: ${error.message}\n`);
  if (error.envelope.hint) runtime.stderr.write(`Hint: ${error.envelope.hint}\n`);
}

// ─── Human rendering ─────────────────────────────────────────────────────────

const MAX_COLUMNS = 7;
const MAX_CELL = 48;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  const flat = text.replace(/\s+/g, " ");
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 3)}...` : flat;
}

/** A plain-text table of rows; columns default to the first rows' scalar keys. */
export function renderTable(rows: readonly Record<string, unknown>[], columns?: readonly string[]): string {
  if (rows.length === 0) return "(no rows)";
  const keys = columns ?? (() => {
    const seen: string[] = [];
    for (const row of rows.slice(0, 20)) {
      for (const [key, value] of Object.entries(row)) {
        if (seen.includes(key) || (typeof value === "object" && value !== null)) continue;
        seen.push(key);
      }
    }
    return seen.slice(0, MAX_COLUMNS);
  })();
  if (keys.length === 0) return rows.map((row) => JSON.stringify(row)).join("\n");
  const body = rows.map((row) => keys.map((key) => cell(row[key])));
  const widths = keys.map((key, index) => Math.max(key.length, ...body.map((line) => line[index]!.length)));
  const line = (values: readonly string[]) => values.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd();
  return [line(keys), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

/** The row array a list payload carries: the value itself, a common key, or its largest top-level array. */
export function rowsOf(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) return data.every(isRecord) ? data : null;
  if (!isRecord(data)) return null;
  for (const key of ["items", "rows", "data", "results", "records", "nodes", "hits"]) {
    const value = data[key];
    if (Array.isArray(value) && value.every(isRecord)) return value;
  }
  let best: Record<string, unknown>[] | null = null;
  for (const value of Object.values(data)) {
    if (Array.isArray(value) && value.length > 0 && value.every(isRecord) && (!best || value.length > best.length)) best = value;
  }
  return best;
}

/** Readable text for any payload: a table for rows, `key: value` lines for objects. */
export function renderHuman(value: unknown): string {
  const rows = rowsOf(value);
  if (rows) {
    const scalars = isRecord(value)
      ? Object.entries(value).filter(([, item]) => item === null || typeof item !== "object")
      : [];
    const header = scalars.map(([key, item]) => `${key}: ${cell(item)}`).join("\n");
    return header ? `${header}\n\n${renderTable(rows)}` : renderTable(rows);
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([key, item]) =>
      item !== null && typeof item === "object" ? `${key}: ${JSON.stringify(item)}` : `${key}: ${cell(item)}`,
    ).join("\n");
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
