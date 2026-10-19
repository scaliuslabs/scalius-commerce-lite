import { CliError } from "./errors.js";

// `--select /a,/items/*/id`: the same JSON-pointer projection the MCP read
// tool applies (`*` walks every array element), kept in the original shape.

export const MAX_SELECT_POINTERS = 24;
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `--select` value: comma-separated JSON pointers, each starting with `/`. */
export function parseSelect(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const pointers = value.split(",").map((pointer) => pointer.trim()).filter(Boolean);
  if (pointers.length === 0) throw new CliError(2, "invalid_select", "--select needs at least one JSON pointer such as /items/*/id.");
  if (pointers.length > MAX_SELECT_POINTERS) {
    throw new CliError(2, "invalid_select", `--select accepts at most ${MAX_SELECT_POINTERS} pointers.`);
  }
  for (const pointer of pointers) {
    if (!POINTER.test(pointer) || pointer.length > 200) {
      throw new CliError(2, "invalid_select", `'${pointer.slice(0, 80)}' is not a JSON pointer (use /field/*/child).`);
    }
  }
  return pointers;
}

function tokens(pointer: string): string[] {
  return pointer.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function pick(value: unknown, path: readonly string[]): unknown {
  if (path.length === 0) return value;
  const [token, ...rest] = path as [string, ...string[]];
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
    return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => merge(left[index], right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const result: Record<string, unknown> = { ...left };
    for (const [key, value] of Object.entries(right)) result[key] = merge(result[key], value);
    return result;
  }
  return right;
}

export function selectPointers(value: unknown, pointers: readonly string[]): unknown {
  let projected: unknown;
  for (const pointer of pointers) projected = merge(projected, pick(value, tokens(pointer)));
  const compact = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return Array.from(candidate, (item) => item === undefined ? null : compact(item));
    if (isRecord(candidate)) return Object.fromEntries(Object.entries(candidate).map(([key, item]) => [key, compact(item)]));
    return candidate;
  };
  return projected === undefined ? null : compact(projected);
}
