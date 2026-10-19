// Response shaping for the MCP tools: unwrap the route envelope, project the
// fields the agent selected, report pagination as one opaque cursor, and keep
// every result inside its byte budget (8 KB by default) by returning the
// first rows plus `truncated` rather than a context-filling page.

import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { AgentDispatchError, type AgentInputPrimitive, type AgentOperationInput } from "../dispatch";
import { AGENT_MAX_RESULT_BYTES, utf8ByteLength } from "../limits";
import { AGENT_STEP_POINTER_PATTERN } from "./references";

export const AGENT_READ_BUDGET_BYTES = 8 * 1024;
export const AGENT_MAX_SELECT_POINTERS = 24;
export const AGENT_DEFAULT_LIST_LIMIT = 20;
const CURSOR_PREFIX = "sc1.";
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface ShapedMeta {
  hasMore?: boolean;
  nextCursor?: string | null;
  total?: number;
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

function encodeCursor(patch: Record<string, AgentInputPrimitive>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(patch));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return CURSOR_PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(cursor: string): Record<string, unknown> | null {
  if (!cursor.startsWith(CURSOR_PREFIX)) return null;
  try {
    const base64 = cursor.slice(CURSOR_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Applies the tool-level `limit` and `cursor` to a read's query: `limit`
 * fills the operation's own `limit` parameter (lists default to 20), and a
 * cursor from `meta.nextCursor` restores the page parameter it encodes.
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
    const patch = decodeCursor(controls.cursor);
    if (patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (POISON_KEYS.has(key) || !parameters.has(key)) {
          throw new AgentDispatchError("invalid_cursor", "The cursor does not belong to this operation", 400);
        }
        if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
          throw new AgentDispatchError("invalid_cursor", "The cursor is malformed", 400);
        }
        query[key] = value as AgentInputPrimitive;
      }
    } else if (parameters.has("cursor")) {
      query.cursor = controls.cursor;
    } else {
      throw new AgentDispatchError("invalid_cursor", `${operation.operationId} does not page by cursor`, 400);
    }
  }
  return Object.keys(query).length > 0 || input.query ? { ...input, query } : input;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Pagination facts a list response carries, with the next page as one opaque cursor. */
export function paginationMeta(
  operation: AgentOperationManifestEntry,
  data: unknown,
): Pick<ShapedMeta, "hasMore" | "nextCursor" | "total"> {
  if (!isRecord(data)) return {};
  const parameters = queryParameters(operation);
  const meta: Pick<ShapedMeta, "hasMore" | "nextCursor" | "total"> = {};
  const pagination = isRecord(data.pagination) ? data.pagination : isRecord(data.meta) ? data.meta : data;
  const page = finiteNumber(pagination.page);
  const totalPages = finiteNumber(pagination.totalPages);
  const total = finiteNumber(pagination.total) ?? finiteNumber(data.total) ?? finiteNumber(data.totalCount);
  if (total !== undefined) meta.total = total;
  if (page !== undefined && totalPages !== undefined && parameters.has("page")) {
    meta.hasMore = page < totalPages;
    meta.nextCursor = meta.hasMore ? encodeCursor({ page: page + 1 }) : null;
    return meta;
  }
  for (const [key, value] of Object.entries(data)) {
    if (key === "nextCursor" || key === "cursor" && "hasMore" in data) {
      meta.nextCursor = typeof value === "string" && value ? (parameters.has("cursor") ? value : encodeCursor({ cursor: value })) : null;
      meta.hasMore = typeof data.hasMore === "boolean" ? data.hasMore : meta.nextCursor !== null;
      return meta;
    }
    const match = key.match(/^next([A-Z][A-Za-z0-9]*)$/);
    if (match) {
      const parameter = match[1]!.charAt(0).toLowerCase() + match[1]!.slice(1);
      if (parameters.has(parameter)) {
        const usable = value !== null && value !== undefined && ["string", "number"].includes(typeof value);
        meta.nextCursor = usable ? encodeCursor({ [parameter]: value as string | number }) : null;
        meta.hasMore = usable;
        return meta;
      }
    }
  }
  if (typeof data.hasMore === "boolean") meta.hasMore = data.hasMore;
  else if (typeof data.hasNextPage === "boolean") meta.hasMore = data.hasNextPage;
  return meta;
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
    if (Array.isArray(candidate)) return candidate.map((item) => item === undefined ? null : compact(item));
    if (isRecord(candidate)) return Object.fromEntries(Object.entries(candidate).map(([key, item]) => [key, compact(item)]));
    return candidate;
  };
  return projected === undefined ? null : compact(projected);
}

interface ArraySlot {
  bytes: number;
  length: number;
  replace: (rows: number) => unknown;
}

/** The arrays a list payload keeps its rows in: the value itself, or arrays up to two levels down. */
function arraySlots(data: unknown): ArraySlot[] {
  const slots: ArraySlot[] = [];
  if (Array.isArray(data)) {
    slots.push({ bytes: jsonBytes(data), length: data.length, replace: (rows) => data.slice(0, rows) });
    return slots;
  }
  if (!isRecord(data)) return slots;
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      slots.push({ bytes: jsonBytes(value), length: value.length, replace: (rows) => ({ ...data, [key]: value.slice(0, rows) }) });
    } else if (isRecord(value)) {
      for (const [innerKey, inner] of Object.entries(value)) {
        if (!Array.isArray(inner)) continue;
        slots.push({
          bytes: jsonBytes(inner),
          length: inner.length,
          replace: (rows) => ({ ...data, [key]: { ...value, [innerKey]: inner.slice(0, rows) } }),
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
 * cut to the rows that fit (`returned` of `pageRows`); without one, the agent
 * gets an outline of the keys and sizes. Either way `truncated` and a hint
 * name the way to the rest: `select` or `cursor`.
 */
export function fitToBudget(data: unknown, budget: number): { data: unknown; meta: ShapedMeta } {
  const limit = Math.max(512, Math.min(budget, AGENT_MAX_RESULT_BYTES));
  if (jsonBytes(data) <= limit) return { data, meta: {} };
  const hint = "Over the result budget: use select for the fields you need, a smaller limit, or the cursor.";
  for (const slot of arraySlots(data)) {
    let low = 0;
    let high = slot.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (jsonBytes(slot.replace(middle)) <= limit) low = middle;
      else high = middle - 1;
    }
    const cut = slot.replace(low);
    if (jsonBytes(cut) <= limit && (low > 0 || slot.length > 0)) {
      return { data: cut, meta: { truncated: true, returned: low, pageRows: slot.length, hint } };
    }
  }
  return { data: outline(data), meta: { truncated: true, hint } };
}
