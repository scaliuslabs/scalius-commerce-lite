// Response shaping for the MCP tools: unwrap the route envelope, project the
// fields the agent selected, report a cursor list's next page, and keep
// every result inside its byte budget (8 KB by default) by returning the
// first rows plus `truncated` rather than a context-filling page.

import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { AgentDispatchError, type AgentInputPrimitive, type AgentOperationInput } from "../dispatch";
import { AGENT_MAX_RESULT_BYTES, utf8ByteLength } from "../limits";
import { AGENT_STEP_POINTER_PATTERN } from "./references";

export const AGENT_READ_BUDGET_BYTES = 8 * 1024;
export const AGENT_MAX_SELECT_POINTERS = 24;
export const AGENT_DEFAULT_LIST_LIMIT = 20;
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface ShapedMeta {
  hasMore?: boolean;
  nextCursor?: string | null;
  truncated?: true;
  /** Rows returned of `pageRows` in this page when the page was cut to the budget. */
  returned?: number;
  pageRows?: number;
  hint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const jsonBytes = (value: unknown) => utf8ByteLength(JSON.stringify(value) ?? "null");

/** The route's payload: `{success:true, data}` becomes `data`; anything else is returned as is. */
export function unwrapRouteBody(body: unknown): unknown {
  if (isRecord(body) && body.success === true && "data" in body) return body.data;
  return body;
}

interface QueryParameter {
  name: string;
  schema: Record<string, unknown>;
}

function queryParameters(operation: AgentOperationManifestEntry): Map<string, QueryParameter> {
  const input = isRecord(operation.inputSchema) ? operation.inputSchema : {};
  const parameters = Array.isArray(input.parameters) ? input.parameters : [];
  const result = new Map<string, QueryParameter>();
  for (const parameter of parameters) {
    if (!isRecord(parameter) || parameter.in !== "query" || typeof parameter.name !== "string") continue;
    result.set(parameter.name, { name: parameter.name, schema: isRecord(parameter.schema) ? parameter.schema : {} });
  }
  return result;
}

/**
 * Applies the tool-level `limit` and `cursor` to a read's query: `limit`
 * fills the operation's own `limit` parameter (lists default to 20), and a
 * cursor (`meta.nextCursor`) is the operation's own `cursor` parameter.
 */
export function applyListControls(
  operation: AgentOperationManifestEntry,
  input: AgentOperationInput,
  controls: { limit?: number; cursor?: string },
): AgentOperationInput {
  const parameters = queryParameters(operation);
  const query: Record<string, AgentInputPrimitive | AgentInputPrimitive[]> = { ...(input.query ?? {}) };
  const limitParameter = parameters.get("limit");
  if (limitParameter) {
    const maximum = typeof limitParameter.schema.maximum === "number" ? limitParameter.schema.maximum : null;
    const fallback = typeof limitParameter.schema.default === "number" ? limitParameter.schema.default : null;
    if (controls.limit !== undefined) {
      query.limit = maximum === null ? controls.limit : Math.min(controls.limit, maximum);
    } else if (query.limit === undefined && (fallback === null || fallback > AGENT_DEFAULT_LIST_LIMIT)) {
      query.limit = maximum === null ? AGENT_DEFAULT_LIST_LIMIT : Math.min(AGENT_DEFAULT_LIST_LIMIT, maximum);
    }
  } else if (controls.limit !== undefined) {
    throw new AgentDispatchError("limit_not_supported", `${operation.operationId} has no limit parameter`, 400);
  }
  if (controls.cursor !== undefined) {
    if (!parameters.has("cursor")) {
      throw new AgentDispatchError("invalid_cursor", `${operation.operationId} does not page by cursor`, 400);
    }
    query.cursor = controls.cursor;
  }
  return Object.keys(query).length > 0 || input.query ? { ...input, query } : input;
}

/** The next page of a cursor list (`{ ..., nextCursor }`): the one way lists page. */
export function cursorMeta(data: unknown): Pick<ShapedMeta, "hasMore" | "nextCursor"> {
  if (!isRecord(data) || !("nextCursor" in data)) return {};
  const nextCursor = typeof data.nextCursor === "string" && data.nextCursor ? data.nextCursor : null;
  return { nextCursor, hasMore: nextCursor !== null };
}

function parsePointer(pointer: string): string[] {
  if (!pointer.startsWith("/") || !AGENT_STEP_POINTER_PATTERN.test(pointer)) {
    throw new AgentDispatchError("invalid_select", `Select pointer '${pointer.slice(0, 80)}' is not a JSON pointer`, 400);
  }
  return pointer.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function pick(value: unknown, tokens: readonly string[]): unknown {
  if (tokens.length === 0) return value;
  const [token, ...rest] = tokens as [string, ...string[]];
  if (POISON_KEYS.has(token)) return undefined;
  if (token === "*" && Array.isArray(value)) return value.map((item) => pick(item, rest));
  if (Array.isArray(value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
    const index = Number(token);
    if (index >= value.length) return undefined;
    const picked = pick(value[index], rest);
    if (picked === undefined) return undefined;
    const sparse: unknown[] = [];
    sparse[index] = picked;
    return sparse;
  }
  if (isRecord(value) && Object.hasOwn(value, token)) {
    const picked = pick(value[token], rest);
    return picked === undefined ? undefined : { [token]: picked };
  }
  return undefined;
}

function merge(left: unknown, right: unknown): unknown {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    return Array.from({ length }, (_, index) => merge(left[index], right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const result: Record<string, unknown> = { ...left };
    for (const [key, value] of Object.entries(right)) result[key] = merge(result[key], value);
    return result;
  }
  return right;
}

/**
 * Projects JSON pointers (`/items/*\/id`; `*` walks every array element)
 * into one value keeping the original structure. Missing paths are omitted.
 */
export function selectPointers(value: unknown, pointers: readonly string[]): unknown {
  if (pointers.length > AGENT_MAX_SELECT_POINTERS) {
    throw new AgentDispatchError("invalid_select", `At most ${AGENT_MAX_SELECT_POINTERS} select pointers are allowed`, 400);
  }
  let projected: unknown;
  for (const pointer of pointers) projected = merge(projected, pick(value, parsePointer(pointer)));
  const compact = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return Array.from(candidate, (item) => item === undefined ? null : compact(item));
    if (isRecord(candidate)) return Object.fromEntries(Object.entries(candidate).map(([key, item]) => [key, compact(item)]));
    return candidate;
  };
  return projected === undefined ? null : compact(projected);
}

interface ArraySlot {
  bytes: number;
  length: number;
  /** The rows are a time series, oldest first: a cut keeps the newest rows. */
  oldestFirst: boolean;
  replace: (rows: number) => unknown;
}

/**
 * A time series ordered oldest first: every row carries a `date` string
 * (ISO, so text order is time order), never decreasing, and the series spans
 * more than one date. Cutting such a series from the end would drop today.
 */
function isOldestFirstSeries(rows: readonly unknown[]): boolean {
  if (rows.length < 2) return false;
  let previous = "";
  for (const row of rows) {
    if (!isRecord(row) || typeof row.date !== "string" || row.date < previous) return false;
    previous = row.date;
  }
  return (rows[0] as { date: string }).date < previous;
}

/** The `rows` a cut keeps: a list's first rows, or an oldest-first series' last (newest) ones. */
function keptRows(array: readonly unknown[], rows: number, oldestFirst: boolean): unknown[] {
  return oldestFirst ? array.slice(array.length - rows) : array.slice(0, rows);
}

/** The arrays a list payload keeps its rows in: the value itself, or arrays up to two levels down. */
function arraySlots(data: unknown, paged: boolean): ArraySlot[] {
  const slots: ArraySlot[] = [];
  // A cursor continues after the page's last row, so a paged list always keeps its head.
  const oldestFirst = (rows: readonly unknown[]) => !paged && isOldestFirstSeries(rows);
  if (Array.isArray(data)) {
    const tail = oldestFirst(data);
    slots.push({ bytes: jsonBytes(data), length: data.length, oldestFirst: tail, replace: (rows) => keptRows(data, rows, tail) });
    return slots;
  }
  if (!isRecord(data)) return slots;
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      const tail = oldestFirst(value);
      slots.push({
        bytes: jsonBytes(value),
        length: value.length,
        oldestFirst: tail,
        replace: (rows) => ({ ...data, [key]: keptRows(value, rows, tail) }),
      });
    } else if (isRecord(value)) {
      for (const [innerKey, inner] of Object.entries(value)) {
        if (!Array.isArray(inner)) continue;
        const tail = oldestFirst(inner);
        slots.push({
          bytes: jsonBytes(inner),
          length: inner.length,
          oldestFirst: tail,
          replace: (rows) => ({ ...data, [key]: { ...value, [innerKey]: keptRows(inner, rows, tail) } }),
        });
      }
    }
  }
  return slots.sort((left, right) => right.bytes - left.bytes);
}

/** The keys of an over-budget payload, each with its type and size, when no row cut fits. */
function outline(data: unknown): unknown {
  if (Array.isArray(data)) return { type: "array", length: data.length, bytes: jsonBytes(data) };
  if (!isRecord(data)) return { type: typeof data, bytes: jsonBytes(data) };
  return Object.fromEntries(Object.entries(data).slice(0, 40).map(([key, value]) => {
    if (value === null || ["number", "boolean"].includes(typeof value)) return [key, value];
    if (typeof value === "string" && value.length <= 64) return [key, value];
    if (Array.isArray(value)) return [key, `<array of ${value.length}, ${jsonBytes(value)} bytes>`];
    if (isRecord(value)) return [key, `<object with ${Object.keys(value).length} keys, ${jsonBytes(value)} bytes>`];
    return [key, `<${typeof value}, ${jsonBytes(value)} bytes>`];
  }));
}

/**
 * Keeps `data` within `budget` bytes. Over budget, the largest row array is
 * cut to the rows that fit (`returned` of `pageRows`): a list keeps its first
 * rows, an unpaged oldest-first time series (`date` rows such as daily
 * activity) its newest ones, so today is never the row that is dropped.
 * Without a row array, the agent gets an outline of the keys and sizes.
 * Either way `truncated` and a hint name the way to the rest: `select` or
 * `cursor`. `paged`: the payload carries a cursor or page.
 */
export function fitToBudget(
  data: unknown,
  budget: number,
  options: { paged?: boolean } = {},
): { data: unknown; meta: ShapedMeta } {
  const limit = Math.max(512, Math.min(budget, AGENT_MAX_RESULT_BYTES));
  if (jsonBytes(data) <= limit) return { data, meta: {} };
  const hint = "Over the result budget: use select for the fields you need, a smaller limit, or the cursor.";
  for (const slot of arraySlots(data, options.paged === true)) {
    const cutHint = slot.oldestFirst
      ? "Over the result budget: the oldest rows were dropped and the newest kept; use select for the fields you need or ask for a shorter range."
      : hint;
    let low = 0;
    let high = slot.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (jsonBytes(slot.replace(middle)) <= limit) low = middle;
      else high = middle - 1;
    }
    const cut = slot.replace(low);
    if (jsonBytes(cut) <= limit && (low > 0 || slot.length > 0)) {
      return { data: cut, meta: { truncated: true, returned: low, pageRows: slot.length, hint: cutHint } };
    }
  }
  return { data: outline(data), meta: { truncated: true, hint } };
}
