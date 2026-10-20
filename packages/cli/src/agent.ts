import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { ConfigStore } from "./config.js";
import { CliError } from "./errors.js";
import { compileJq } from "./jq.js";
import { callTool, toolError, type Audience, type ToolResult } from "./mcp-client.js";
import { findOperation, getIndexedOperations, isObjectOperationId } from "./openapi.js";
import { renderHuman, renderTable, rowsOf, writeDiagnostic, writeLines, writeRawValues, writeResult } from "./output.js";
import { selectPointers } from "./select.js";
import type { IndexedOperation, OutputMode, ResolvedProfile, Runtime, StructuredInput } from "./types.js";

// The agent-first commands: ask, search, describe, read, write and batch.
// Each prints one envelope `{ok, data, meta}` (JSON when piped, text on a
// terminal), and every change follows search -> describe -> dry run ->
// approve -> write -> verify. A gated change runs only after a person
// approves it: on a terminal the CLI offers the server's dialog and asks
// there; otherwise (a pipe, an agent) the server answers 428 with an approval
// link for the merchant's dashboard, and the command ends with exit 10 until
// it is run again with --approval <id>. --yes never approves a gated change.

export interface OutputOptions {
  mode: OutputMode;
  select?: string[];
  jq?: string;
  profile?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function audienceForOperation(operationId: string): Audience {
  if (operationId.startsWith("dashboard.") || isObjectOperationId(operationId)) return "dashboard";
  if (operationId.startsWith("storefront.")) return "storefront";
  throw new CliError(2, "invalid_operation_id", "Use a dashboard., storefront. or objects. operation ID.");
}

export async function profileFor(runtime: Runtime, audience: Audience, requested?: string): Promise<ResolvedProfile> {
  return new ConfigStore(runtime).resolveProfileForResource(audience, requested, true);
}

/** Prints an envelope: `--jq` over its data, else JSON or human text. */
export function emit(runtime: Runtime, output: OutputOptions, envelope: Record<string, unknown>, human?: () => string): void {
  let value = envelope;
  if (output.select && "data" in envelope && !envelope.selected) {
    value = { ...envelope, data: selectPointers(envelope.data, output.select) };
  }
  if (output.jq) {
    writeRawValues(runtime, compileJq(output.jq)("data" in value ? value.data : value));
    return;
  }
  if (output.mode === "json") {
    const { selected: _selected, ...rest } = value;
    writeResult(runtime, "json", rest);
    return;
  }
  writeResult(runtime, "human", value, human ? human() : renderHuman("data" in value ? value.data : value));
}

function okEnvelope(result: ToolResult, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { ok: _ok, meta, ...rest } = result.value;
  const data = "data" in rest ? rest.data : rest;
  return { ok: true, data, ...(isRecord(meta) ? { meta } : {}), ...extra };
}

async function tool(
  runtime: Runtime,
  profile: ResolvedProfile,
  audience: Audience,
  name: string,
  args: Record<string, unknown>,
  retry: boolean,
): Promise<ToolResult> {
  const result = await callTool(runtime, profile, audience, name, args, { retry });
  if (result.isError) throw toolError(result.value);
  return result;
}

// ─── ask / search / describe ─────────────────────────────────────────────────

export async function ask(runtime: Runtime, output: OutputOptions, question: string, audience: Audience): Promise<void> {
  const profile = await profileFor(runtime, audience, output.profile);
  const result = await tool(runtime, profile, audience, "scalius_answer", { question }, true);
  const value = result.value;
  emit(runtime, output, { ok: true, data: (({ ok: _ok, ...rest }) => rest)(value) }, () => {
    if (value.kind === "unavailable") {
      const hits = Array.isArray(value.hits) ? value.hits.filter(isRecord) : [];
      return [
        "No curated answer for that question. Closest capabilities:",
        renderTable(hits, ["id", "kind", "risk", "title"]),
        "Next: scalius describe <id>, then scalius read <id>.",
      ].join("\n");
    }
    const outputs = isRecord(value.outputs) ? value.outputs : value;
    return `${String(value.workflowId ?? "answer")}\n${JSON.stringify(outputs, null, 2)}`;
  });
}

export async function search(runtime: Runtime, output: OutputOptions, query: string, audience: Audience, limit?: number): Promise<void> {
  const profile = await profileFor(runtime, audience, output.profile);
  const result = await tool(runtime, profile, audience, "scalius_search", { query, ...(limit ? { limit } : {}) }, true);
  const hits = Array.isArray(result.value.hits) ? result.value.hits.filter(isRecord) : [];
  emit(runtime, output, okEnvelope(result), () => {
    const rows = hits.map((hit) => ({
      id: hit.id,
      kind: hit.kind,
      risk: hit.risk ?? "",
      confirm: hit.confirm === true ? "yes" : "",
      score: hit.score,
      title: hit.title,
    }));
    const lines = [renderTable(rows)];
    const top = hits[0];
    const plan = top && isRecord(top.plan) ? top.plan : undefined;
    const steps = Array.isArray(plan?.operationIds) ? plan.operationIds : Array.isArray(top?.operationIds) ? top.operationIds : undefined;
    if (steps) lines.push("", `${plan ? "Plan" : "Steps"} for ${String(top!.id)}: ${steps.join(" -> ")}`);
    for (const rule of Array.isArray(plan?.rules) ? plan.rules.slice(0, 4) : []) lines.push(`  - ${String(rule)}`);
    const control = hits.find((hit) => hit.kind === "control");
    if (control) lines.push("", `Control (${String(control.disposition)}): ${String(control.summary)}`);
    const notes = Array.isArray(result.value.notes) ? result.value.notes : [];
    for (const note of notes) lines.push(`Note: ${String(note)}`);
    lines.push("", "Next: scalius describe <id> for inputs and an example.");
    return lines.join("\n");
  });
}

export async function describe(
  runtime: Runtime,
  output: OutputOptions,
  ids: string[],
  detail: "compact" | "full" | "examples",
): Promise<void> {
  if (ids.length < 1 || ids.length > 5) throw new CliError(2, "invalid_input", "Describe 1 to 5 operation IDs at a time.");
  const audiences = new Set(ids.map(audienceForOperation));
  if (audiences.size !== 1) throw new CliError(2, "mixed_audience", "Describe dashboard and storefront operations separately.");
  const audience = [...audiences][0]!;
  const profile = await profileFor(runtime, audience, output.profile);
  const result = await tool(runtime, profile, audience, "scalius_describe", { ids, detail }, true);
  const operations = Array.isArray(result.value.operations) ? result.value.operations.filter(isRecord) : [];
  emit(runtime, output, okEnvelope(result), () => operations.map((operation) => {
    const lines = [`${String(operation.operationId)} [${String(operation.risk ?? "")}${operation.dryRun ? `, dry run ${String(operation.dryRun)}` : ""}]`];
    if (isRecord(operation.error)) return `${lines[0]}\n  ${String(operation.error.message)}`;
    if (operation.purpose) lines.push(`  ${String(operation.purpose)}`);
    if (operation.when) lines.push(`  When: ${String(operation.when)}`);
    const inputs = isRecord(operation.inputs) ? operation.inputs : {};
    for (const [location, fields] of Object.entries(inputs)) {
      if (Array.isArray(fields)) lines.push(`  ${location}: ${fields.join(", ")}`);
    }
    for (const rule of Array.isArray(operation.rules) ? operation.rules : []) lines.push(`  Rule: ${String(rule)}`);
    if (operation.example !== undefined) lines.push(`  Example --input: ${JSON.stringify(operation.example)}`);
    if (Array.isArray(operation.returns)) lines.push(`  Returns: ${operation.returns.join(", ")}`);
    return lines.join("\n");
  }).join("\n\n"));
}

// ─── read ────────────────────────────────────────────────────────────────────

export interface ReadOptions {
  input: StructuredInput;
  select?: string[];
  limit?: number;
  cursor?: string;
  maxBytes?: number;
  all: boolean;
  ndjson: boolean;
}

const ALL_PAGE_BYTES = 64 * 1024;
const MAX_PAGES = 10_000;
const MAX_RATE_WAITS = 6;

function hasQueryParameter(operation: IndexedOperation, name: string): boolean {
  return operation.pathParameters.some((parameter) => parameter.in === "query" && parameter.name === name);
}

/** A cursor that encodes a page number cannot survive a changed page size. */
function isPageCursor(cursor: string | undefined): boolean {
  if (!cursor?.startsWith("sc1.")) return false;
  try {
    const decoded = JSON.parse(Buffer.from(cursor.slice(4), "base64url").toString("utf8")) as unknown;
    return isRecord(decoded) && "page" in decoded;
  } catch {
    return false;
  }
}

export async function localOperation(runtime: Runtime, profile: ResolvedProfile, operationId: string): Promise<IndexedOperation> {
  const { operations } = await getIndexedOperations(runtime, profile);
  return findOperation(operations, operationId);
}

export async function readPage(
  runtime: Runtime,
  profile: ResolvedProfile,
  audience: Audience,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  for (let wait = 0; ; wait += 1) {
    const result = await callTool(runtime, profile, audience, "scalius_read", args, { retry: true });
    if (!result.isError) return result;
    const error = toolError(result.value);
    const temporary = error.envelope.retryable === true && (error.envelope.status === 429 || error.envelope.status === 503);
    if (!temporary || wait >= MAX_RATE_WAITS) throw error;
    await runtime.sleep(error.envelope.retryAfterMs ?? Math.min(2_000 * 2 ** wait, 30_000));
  }
}

export async function read(runtime: Runtime, output: OutputOptions, operationId: string, options: ReadOptions): Promise<void> {
  const audience = audienceForOperation(operationId);
  const profile = await profileFor(runtime, audience, output.profile);
  const operation = await localOperation(runtime, profile, operationId);
  if (operation.agent.risk !== "read") {
    throw new CliError(2, "operation_risk_mismatch", `${operationId} changes the store; use scalius write.`);
  }
  const base: Record<string, unknown> = {
    operationId,
    input: options.input,
    ...(options.select ? { select: options.select } : {}),
  };
  if (!options.all) {
    const result = await readPage(runtime, profile, audience, {
      ...base,
      ...(options.limit ? { limit: options.limit } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
    });
    const envelope: Record<string, unknown> = { ...okEnvelope(result), selected: true };
    if (options.ndjson && !output.jq) {
      writeLines(runtime, rowsOf(envelope.data) ?? [envelope.data]);
      return;
    }
    emit(runtime, output, envelope, () => {
      const meta = isRecord(envelope.meta) ? envelope.meta : {};
      const footer = [
        meta.truncated ? `Truncated: ${String(meta.hint ?? "use --select or --limit")}` : "",
        meta.hasMore && meta.nextCursor ? `More: --cursor ${String(meta.nextCursor)} (or --all)` : "",
      ].filter(Boolean).join("\n");
      return `${renderHuman(envelope.data)}${footer ? `\n\n${footer}` : ""}`;
    });
    return;
  }

  // --all: follow nextCursor to the end, one record per line. A page cut to
  // the byte budget is fetched again with fewer rows, so no row is skipped.
  const jq = output.jq ? compileJq(output.jq) : undefined;
  const human = output.mode === "human" && !options.ndjson && !jq;
  const collected: Record<string, unknown>[] = [];
  const supportsLimit = hasQueryParameter(operation, "limit");
  let limit = options.limit;
  let cursor = options.cursor;
  let rowCount = 0;
  let pages = 0;
  let total: number | undefined;
  while (pages < MAX_PAGES) {
    const result = await readPage(runtime, profile, audience, {
      ...base,
      maxBytes: options.maxBytes ?? ALL_PAGE_BYTES,
      ...(limit ? { limit } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const meta = isRecord(result.value.meta) ? result.value.meta : {};
    if (meta.truncated === true) {
      const returned = typeof meta.returned === "number" ? meta.returned : 0;
      const restartable = rowCount === 0 && pages === 0 && cursor === options.cursor;
      if (!supportsLimit || returned < 1 || (isPageCursor(cursor) && !restartable)) {
        throw new CliError(5, "page_too_large", "One page of this read is larger than the result budget.", undefined, {
          hint: "Narrow each row with --select (for example /items/*/id,/items/*/name) or lower --limit.",
        });
      }
      limit = returned;
      continue;
    }
    pages += 1;
    if (typeof meta.total === "number") total = meta.total;
    const data = result.value.data;
    const rows = rowsOf(data) ?? [data as Record<string, unknown>];
    for (const row of rows) {
      rowCount += 1;
      if (jq) writeRawValues(runtime, jq(row));
      else if (human) collected.push(row);
      else writeLines(runtime, [row]);
    }
    const next = typeof meta.nextCursor === "string" && meta.nextCursor ? meta.nextCursor : undefined;
    if (meta.hasMore !== true || !next) break;
    cursor = next;
  }
  if (human) runtime.stdout.write(`${renderTable(collected)}\n`);
  if (runtime.stderr.isTTY) {
    writeDiagnostic(runtime, `Read ${rowCount} row(s) in ${pages} page(s)${total === undefined ? "" : ` of ${total}`}.`);
  }
}

// ─── write ───────────────────────────────────────────────────────────────────

export interface WriteOptions {
  input: StructuredInput;
  dryRun: boolean;
  yes: boolean;
  /** The approval the merchant gave in the dashboard for exactly this change. */
  approval?: string;
  idempotencyKey?: string;
  /** false: return the envelope without printing it (bulk --wait prints the run instead). */
  print?: boolean;
  /** A dry run's extra facts: `note` is printed above the preview, `fields` join the envelope. */
  preview?: { note?: string; fields?: Record<string, unknown> };
}

export interface WriteOutcome {
  code: number;
  envelope: Record<string, unknown>;
}

const MAX_WRITE_ATTEMPTS = 4;

function factValue(value: unknown): string | null {
  if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 37)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  return null;
}

/** "Process order refund: id=ord_1, amount=500": what the merchant approves (no secrets). */
export function localSummary(operation: IndexedOperation, input: StructuredInput): string {
  const facts: string[] = [];
  for (const [key, value] of Object.entries(input.path ?? {})) facts.push(`${key}=${String(value)}`);
  if (isRecord(input.body)) {
    for (const [key, value] of Object.entries(input.body)) {
      if (/key$|token|secret|password/i.test(key)) continue;
      const text = factValue(value);
      if (text !== null) facts.push(`${key}=${text}`);
    }
  }
  for (const [key, value] of Object.entries(input.query ?? {})) {
    const text = factValue(value);
    if (text !== null) facts.push(`${key}=${text}`);
  }
  const title = operation.operation.summary || operation.id;
  const text = facts.length > 0 ? `${title}: ${facts.slice(0, 6).join(", ")}` : title;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function interactive(runtime: Runtime): boolean {
  return runtime.stdin.isTTY === true && runtime.stderr.isTTY === true;
}

export async function promptLine(runtime: Runtime, question: string): Promise<string> {
  runtime.stderr.write(question);
  runtime.stdin.resume();
  try {
    let text = "";
    while (!text.includes("\n")) {
      const [chunk] = await once(runtime.stdin, "data") as [Buffer | string];
      text += chunk.toString();
      if (text.includes("\u0003")) throw new CliError(130, "interrupted", "Operation interrupted.");
    }
    return text.split("\n")[0]!.trim();
  } finally {
    runtime.stdin.pause();
  }
}

async function approve(runtime: Runtime, summary: string): Promise<boolean> {
  const answer = await promptLine(runtime, `Approve: ${summary}\nApply this change? [y/N] `);
  return /^y(es)?$/i.test(answer);
}

/** The server dialog's answer comes from the person at the terminal, never from --yes. */
function dialogFor(runtime: Runtime): ((message: string) => Promise<boolean>) | undefined {
  if (!interactive(runtime)) return undefined;
  return (message) => approve(runtime, message.replace(/^Approve: /, ""));
}

interface ApprovalLink {
  summary: string;
  approvalId?: string;
  approvalUrl?: string;
  confirmation?: unknown;
}

/** The server's 428: its summary and the dashboard approval link (the fallback summary when it sent none). */
function approvalLinkOf(value: Record<string, unknown>, fallbackSummary: string): ApprovalLink {
  const confirmation = isRecord(value.confirmation) ? value.confirmation : undefined;
  return {
    summary: typeof confirmation?.summary === "string" ? confirmation.summary : fallbackSummary,
    ...(typeof confirmation?.approvalId === "string" ? { approvalId: confirmation.approvalId } : {}),
    ...(typeof confirmation?.approvalUrl === "string" ? { approvalUrl: confirmation.approvalUrl } : {}),
    ...(confirmation ? { confirmation } : {}),
  };
}

function approvalNeeded(link: ApprovalLink, yes: boolean): CliError {
  const where = link.approvalUrl && link.approvalId
    ? ` Approve it at ${link.approvalUrl}, then run the same command again with --approval ${link.approvalId}.`
    : "";
  const message = yes
    ? `--yes cannot approve this change: the store asks a person to approve it (${link.summary}).${where}`
    : `This change needs the merchant's approval: ${link.summary}.${where}`;
  return new CliError(10, "confirmation_required", message, link.confirmation ? { confirmation: link.confirmation } : undefined, {
    status: 428,
    retryable: false,
    hint: link.approvalUrl
      ? `Send the merchant ${link.approvalUrl}. Once they approve it, run the same command again with --approval ${link.approvalId}. Nothing was changed.`
      : "Ask the merchant to approve the change, then run it again. Nothing was changed.",
  });
}

/**
 * A gated change's dashboard approval. On a terminal the person opens the link
 * and presses Enter once approved (the request is then repeated with the
 * approval id); elsewhere the command ends with exit 10 and sends nothing
 * more. --yes changes neither.
 */
async function settleApprovalLink(runtime: Runtime, yes: boolean, link: ApprovalLink): Promise<string> {
  if (!link.approvalId || !link.approvalUrl || !interactive(runtime)) throw approvalNeeded(link, yes);
  const answer = await promptLine(
    runtime,
    `Approve in the dashboard: ${link.summary}\n${link.approvalUrl}\nPress Enter once approved (n to cancel) `,
  );
  if (/^n(o)?$/i.test(answer)) {
    throw new CliError(10, "confirmation_declined", "The change was not approved; nothing was written.");
  }
  return link.approvalId;
}

const MAX_APPROVAL_PROMPTS = 3;

/** The idempotency key this invocation uses for every attempt of one write. */
export function idempotencyKeyFor(operation: IndexedOperation, requested: string | undefined): string | undefined {
  const support = operation.agent.idempotency ?? "none";
  if (requested && requested !== "auto") {
    if (support === "none") throw new CliError(5, "idempotency_not_supported", `${operation.id} does not take an idempotency key.`);
    if (!/^[\x21-\x7E]{8,200}$/.test(requested)) {
      throw new CliError(5, "invalid_idempotency_key", "Idempotency keys must be 8-200 visible ASCII characters.");
    }
    return requested;
  }
  return support === "none" ? undefined : `sck_${randomUUID()}`;
}

function dryRunEnvelope(result: ToolResult, preview?: WriteOptions["preview"]): Record<string, unknown> {
  const { ok: _ok, dryRun: _dryRun, written: _written, confirmation, steps, ...single } = result.value;
  return {
    ok: true,
    dryRun: true,
    written: false,
    ...(preview?.fields ?? {}),
    data: steps ?? single,
    ...(isRecord(confirmation) ? { confirmation } : {}),
  };
}

function previewText(envelope: Record<string, unknown>, note?: string): string {
  const confirmation = isRecord(envelope.confirmation) ? envelope.confirmation : undefined;
  return [
    "Dry run: nothing was written.",
    ...(note ? [note] : []),
    JSON.stringify(envelope.data, null, 2),
    ...(confirmation ? [
      `Needs approval: ${String(confirmation.summary)}`,
      "Run it without --dry-run: a terminal asks you; otherwise the merchant approves it from a dashboard link.",
    ] : []),
  ].join("\n");
}

async function sendWrite(
  runtime: Runtime,
  profile: ResolvedProfile,
  audience: Audience,
  args: Record<string, unknown>,
  yes: boolean,
  idempotent: boolean,
  fallbackSummary: string,
): Promise<ToolResult> {
  let current = { ...args };
  let prompts = 0;
  for (let attempt = 1; ; attempt += 1) {
    const result = await callTool(runtime, profile, audience, "scalius_write", current, { retry: idempotent, confirm: dialogFor(runtime) });
    if (!result.isError) return result;
    const error = toolError(result.value);
    if (error.errorCode === "confirmation_required") {
      // The server's 428 with a dashboard approval link (or the same link
      // again: not approved yet). Repeat the identical request (same input,
      // same idempotency key) with the approval id once a person approved.
      const link = approvalLinkOf(result.value, fallbackSummary);
      if (prompts >= MAX_APPROVAL_PROMPTS) throw approvalNeeded(link, yes);
      prompts += 1;
      current = { ...current, approvalId: await settleApprovalLink(runtime, yes, link) };
      continue;
    }
    if (!idempotent || attempt >= MAX_WRITE_ATTEMPTS) throw error;
    if (error.envelope.retryable !== true) throw error;
    await runtime.sleep(error.envelope.retryAfterMs ?? 1_000 * attempt);
  }
}

export async function write(runtime: Runtime, output: OutputOptions, operationId: string, options: WriteOptions): Promise<WriteOutcome> {
  const audience = audienceForOperation(operationId);
  const profile = await profileFor(runtime, audience, output.profile);
  const operation = await localOperation(runtime, profile, operationId);
  if (operation.agent.risk === "read") {
    throw new CliError(2, "operation_risk_mismatch", `${operationId} only reads; use scalius read.`);
  }
  if (operation.agent.transport === "multipart" || operation.agent.transport === "octet-stream") {
    throw new CliError(2, "file_transport", `${operationId} uploads files; use 'scalius media upload' or 'scalius operations run --file'.`);
  }
  const idempotencyKey = idempotencyKeyFor(operation, options.idempotencyKey);
  const base: Record<string, unknown> = { operationId, input: options.input, ...(idempotencyKey ? { idempotencyKey } : {}) };
  const dryRunArgs = { operationId, input: options.input, dryRun: true };

  if (options.dryRun) {
    const result = await tool(runtime, profile, audience, "scalius_write", dryRunArgs, true);
    const envelope = dryRunEnvelope(result, options.preview);
    if (options.print !== false) emit(runtime, output, envelope, () => previewText(envelope, options.preview?.note));
    return { code: 11, envelope };
  }

  // Send the change itself: a gated one asks the person (a terminal dialog,
  // or a dashboard link) before anything is written.
  const result = await sendWrite(
    runtime,
    profile,
    audience,
    { ...base, ...(options.approval ? { approvalId: options.approval } : {}) },
    options.yes,
    idempotencyKey !== undefined,
    localSummary(operation, options.input),
  );
  const envelope = okEnvelope(result);
  if (options.print === false) return { code: 0, envelope };
  emit(runtime, output, envelope, () => {
    const meta = isRecord(envelope.meta) ? envelope.meta : {};
    return [
      `${operationId}: done${meta.replayed ? " (replayed)" : ""}${meta.requestId ? ` (request ${String(meta.requestId)})` : ""}`,
      renderHuman(envelope.data),
      "Verify with a read of the changed resource.",
    ].join("\n");
  });
  return { code: 0, envelope };
}

// ─── batch ───────────────────────────────────────────────────────────────────

interface BatchStep {
  id: string;
  operationId: string;
  input?: Record<string, unknown>;
}

function parseSteps(value: unknown): BatchStep[] {
  const raw = isRecord(value) && Array.isArray(value.steps) ? value.steps : Array.isArray(value) ? value : null;
  if (!raw || raw.length < 1 || raw.length > 20) throw new CliError(5, "invalid_batch", "A batch is {\"steps\": [...]} with 1-20 steps.");
  return raw.map((step, index) => {
    if (!isRecord(step) || typeof step.operationId !== "string") throw new CliError(5, "invalid_batch", `Step ${index + 1} needs an operationId.`);
    const id = typeof step.id === "string" ? step.id : `s${index + 1}`;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) throw new CliError(5, "invalid_batch", `Step ${index + 1} has an invalid id (start with a letter).`);
    if (step.input !== undefined && !isRecord(step.input)) throw new CliError(5, "invalid_batch", `Step ${id} input must be an object.`);
    return { id, operationId: step.operationId, ...(step.input ? { input: step.input } : {}) };
  });
}

export async function batch(
  runtime: Runtime,
  output: OutputOptions,
  value: unknown,
  options: { dryRun: boolean; yes: boolean; approval?: string },
): Promise<number> {
  const steps = parseSteps(value);
  const audiences = new Set(steps.map((step) => audienceForOperation(step.operationId)));
  if (audiences.size !== 1) throw new CliError(5, "mixed_audience_batch", "Every step must use the same dashboard or storefront audience.");
  const audience = [...audiences][0]!;
  const profile = await profileFor(runtime, audience, output.profile);
  const { operations } = await getIndexedOperations(runtime, profile);
  const resolved = steps.map((step) => ({ step, operation: findOperation(operations, step.operationId) }));
  const reads = resolved.filter(({ operation }) => operation.agent.risk === "read").length;
  if (reads !== 0 && reads !== resolved.length) {
    throw new CliError(5, "mixed_batch", "A batch is all reads or all writes: split the reads from the changes.");
  }
  const finish = (result: ToolResult) => {
    const envelope = { ok: result.value.ok !== false, data: { steps: result.value.steps }, ...(isRecord(result.value.meta) ? { meta: result.value.meta } : {}) };
    const failed = Array.isArray(result.value.steps)
      ? result.value.steps.filter(isRecord).find((step) => step.ok === false)
      : undefined;
    if (failed) throw toolError(failed as Record<string, unknown>, "batch_step_failed");
    emit(runtime, output, envelope);
    return 0;
  };
  if (reads === resolved.length) {
    const result = await tool(runtime, profile, audience, "scalius_read", { steps }, true);
    return finish(result);
  }
  const keyed = resolved.map(({ step, operation }) => {
    const key = isRecord(step.input) && typeof step.input.idempotencyKey === "string" ? undefined : idempotencyKeyFor(operation, "auto");
    return { ...step, input: { ...(step.input ?? {}), ...(key ? { idempotencyKey: key } : {}) } };
  });
  if (options.dryRun) {
    const result = await tool(runtime, profile, audience, "scalius_write", { steps: keyed, dryRun: true }, true);
    const envelope = dryRunEnvelope(result);
    emit(runtime, output, envelope, () => previewText(envelope));
    return 11;
  }
  let approvalId = options.approval;
  let prompts = 0;
  let result: ToolResult;
  for (;;) {
    result = await callTool(runtime, profile, audience, "scalius_write", { steps: keyed, ...(approvalId ? { approvalId } : {}) }, { retry: false, confirm: dialogFor(runtime) });
    if (!(result.isError && !Array.isArray(result.value.steps))) break;
    const error = toolError(result.value);
    if (error.errorCode !== "confirmation_required") throw error;
    // The server's 428 for the whole batch: nothing ran. Repeat the identical steps once a person approved.
    const fallback = resolved.map(({ step, operation }) => localSummary(operation, step.input ?? {})).join("; ");
    const link = approvalLinkOf(result.value, fallback);
    if (prompts >= MAX_APPROVAL_PROMPTS) throw approvalNeeded(link, options.yes);
    prompts += 1;
    approvalId = await settleApprovalLink(runtime, options.yes, link);
  }
  return finish(result);
}
