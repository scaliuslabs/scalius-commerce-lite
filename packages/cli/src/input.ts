import { readFile } from "node:fs/promises";
import { CliError } from "./errors.js";
import type { FileAssignment, Runtime, StructuredInput } from "./types.js";

const MAX_INPUT_BYTES = 1024 * 1024;

async function readStdin(runtime: Runtime): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of runtime.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.byteLength;
    if (total > MAX_INPUT_BYTES) throw new CliError(5, "input_too_large", "Input exceeds 1 MiB.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonValue(runtime: Runtime, source?: string): Promise<unknown> {
  if (!source) return {};
  let text: string;
  if (source === "-") {
    text = await readStdin(runtime);
  } else if (source.startsWith("@")) {
    const path = source.slice(1);
    if (!path) throw new CliError(2, "invalid_input", "@file input requires a path.");
    let stat: Buffer;
    try {
      stat = await readFile(path);
    } catch {
      throw new CliError(5, "input_read_failed", `Unable to read input file '${path}'.`);
    }
    if (stat.byteLength > MAX_INPUT_BYTES) throw new CliError(5, "input_too_large", "Input exceeds 1 MiB.");
    text = stat.toString("utf8");
  } else {
    if (Buffer.byteLength(source) > MAX_INPUT_BYTES) throw new CliError(5, "input_too_large", "Input exceeds 1 MiB.");
    text = source;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(5, "invalid_json", "Input must be valid JSON.");
  }
  return parsed;
}

export async function readInput(runtime: Runtime, source?: string): Promise<StructuredInput> {
  const parsed = await readJsonValue(runtime, source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(5, "invalid_input", "Operation input must be an object with path, query, and body fields.");
  }
  const input = parsed as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== "path" && key !== "query" && key !== "body") {
      throw new CliError(
        5,
        "invalid_input",
        `Unknown operation input field '${key}'. Group URL values under 'path' or 'query' and JSON payload fields under 'body'.`,
      );
    }
  }
  for (const key of ["path", "query"] as const) {
    const value = input[key];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw new CliError(5, "invalid_input", `${key} must be an object.`);
    }
  }
  return input as StructuredInput;
}

export async function readBatchInput(runtime: Runtime, source: string): Promise<StructuredInput> {
  const parsed = await readJsonValue(runtime, source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(5, "invalid_batch", "Batch input must be a JSON object.");
  }
  return { body: parsed };
}

export function parseFileAssignment(value: string): FileAssignment {
  const separator = value.indexOf("=");
  if (separator < 1 || value[separator + 1] !== "@") {
    throw new CliError(2, "invalid_file", "File values must use field=@path.");
  }
  const field = value.slice(0, separator);
  const path = value.slice(separator + 2);
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(field) || !path) {
    throw new CliError(2, "invalid_file", "File values must use a valid field name and non-empty @path.");
  }
  return { field, path };
}

export function collectFile(value: string, previous: string[]): string[] {
  if (!value || value === "-") {
    throw new CliError(2, "invalid_file", "--file requires a filesystem path; stdin is not accepted for file bodies.");
  }
  return [...previous, value];
}
