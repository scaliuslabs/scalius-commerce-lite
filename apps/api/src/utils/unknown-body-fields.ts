// A zod object strips the keys it does not declare, so without this a write
// route answers 200 to `{ "tags": [...] }` and saves nothing. This finds every
// key of a JSON body that the route's own body schema would drop, at any depth
// (the same schema `@hono/zod-openapi` validates with; nothing is copied), and
// the guard refuses the request as a `validation_error` whose details name
// each such key's path, so the caller learns its field was not saved.
//
// The walk follows the value through the schema the way zod parses it:
// wrappers (optional, nullable, default, readonly...) to their inner schema,
// a pipe or transform to its input side, a union to the option zod picks (the
// first that accepts the value; when none does, a key no option declares),
// an intersection to the keys both sides drop. A schema that accepts any key
// (`.loose()`, a catchall, a record, `z.unknown()`) or that only a transform
// can read (`z.preprocess`) reports nothing. A `.strict()` object would refuse
// its unknown keys itself, but only after the route's path and header checks,
// so the walk names them too, in the same shape.
//
// Choosing a plain union's option parses the whole value once per option, so
// nested unions cost more the deeper they go. A discriminated union's option
// is picked by its discriminator, as zod picks it (no parse), and a body gets
// a bounded number of option parses: past it, the walk reports nothing more
// below an undecided union (the route's own validation still runs), so a large
// or crafted body can never spend the request's CPU here.
import type { MiddlewareHandler } from "hono";
import { ValidationError } from "./api-error";
import { errorResponseFromError } from "./api-response";
import { validationMessage } from "./request-validation-error";

type FieldPath = Array<string | number>;

interface ZodDef {
  type: string;
  [key: string]: unknown;
}

interface ZodLike {
  _zod: { def: ZodDef };
  safeParse(value: unknown): { success: boolean };
}

function isZod(value: unknown): value is ZodLike {
  return typeof value === "object" && value !== null && "_zod" in value
    && typeof (value as { safeParse?: unknown }).safeParse === "function";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "catch", "readonly", "nonoptional", "success"]);
const MAX_DEPTH = 32;
/** Union option parses one body may spend; plenty for every admin body, bounded for any other. */
export const MAX_UNION_OPTION_PARSES = 256;

interface WalkBudget {
  parses: number;
}

/** The schema zod parses a value with, past wrappers, lazies and pipes; null when only a transform reads it. */
function parsingSchema(schema: unknown): ZodLike | null {
  let current = schema;
  for (let step = 0; step < MAX_DEPTH; step += 1) {
    if (!isZod(current)) return null;
    const def = current._zod.def;
    if (WRAPPERS.has(def.type)) current = def.innerType;
    else if (def.type === "lazy") current = (def.getter as () => unknown)();
    else if (def.type === "pipe") current = def.in;
    else if (def.type === "transform") return null;
    else return current;
  }
  return null;
}

function accepts(schema: unknown, value: unknown, budget: WalkBudget): boolean | null {
  if (!isZod(schema)) return null;
  // Out of budget: undecided, so nothing below is reported.
  if (budget.parses >= MAX_UNION_OPTION_PARSES) return null;
  budget.parses += 1;
  try {
    return schema.safeParse(value).success;
  } catch {
    // An async refinement cannot run here: which option zod picks is unknown.
    return null;
  }
}

/**
 * A discriminated union's option for `value`, by its discriminator as zod
 * picks it; undefined when it is no discriminated union or no option claims
 * the value (the bounded option-by-option reading then names what no option
 * declares).
 */
function discriminatedOption(def: ZodDef, options: readonly unknown[], value: unknown): unknown | undefined {
  const discriminator = def.discriminator;
  if (typeof discriminator !== "string" || !isPlainObject(value)) return undefined;
  const claimed = value[discriminator];
  for (const option of options) {
    const values = (option as { _zod?: { propValues?: Record<string, Set<unknown>> } })._zod?.propValues?.[discriminator];
    if (!values) return undefined;
    if (values.has(claimed)) return option;
  }
  return undefined;
}

function walk(schema: unknown, value: unknown, path: FieldPath, out: FieldPath[], depth: number, budget: WalkBudget): void {
  if (depth > MAX_DEPTH) return;
  const node = parsingSchema(schema);
  if (!node) return;
  const def = node._zod.def;
  switch (def.type) {
    case "object": {
      if (!isPlainObject(value)) return;
      const shape = (def.shape ?? {}) as Record<string, unknown>;
      const catchall = def.catchall as ZodLike | undefined;
      for (const key of Object.keys(value)) {
        if (Object.hasOwn(shape, key)) walk(shape[key], value[key], [...path, key], out, depth + 1, budget);
        // Stripped, or refused by `.strict()` (named here too, so a header or path
        // problem zod checks first cannot hide it).
        else if (catchall === undefined || catchall._zod.def.type === "never") out.push([...path, key]);
        else walk(catchall, value[key], [...path, key], out, depth + 1, budget);
      }
      return;
    }
    case "array":
      if (Array.isArray(value)) value.forEach((item, index) => walk(def.element, item, [...path, index], out, depth + 1, budget));
      return;
    case "tuple":
      if (Array.isArray(value)) {
        const items = (def.items ?? []) as unknown[];
        value.forEach((item, index) => walk(index < items.length ? items[index] : def.rest, item, [...path, index], out, depth + 1, budget));
      }
      return;
    case "record":
      if (isPlainObject(value)) {
        for (const key of Object.keys(value)) walk(def.valueType, value[key], [...path, key], out, depth + 1, budget);
      }
      return;
    case "union": {
      const options = (def.options ?? []) as unknown[];
      const picked = discriminatedOption(def, options, value);
      if (picked !== undefined) {
        walk(picked, value, path, out, depth + 1, budget);
        return;
      }
      for (const option of options) {
        const verdict = accepts(option, value, budget);
        if (verdict === null) return;
        if (verdict) {
          walk(option, value, path, out, depth + 1, budget);
          return;
        }
      }
      // No option accepts it: report only what no option declares.
      intersect(options.map((option) => collect(option, value, path, depth, budget)), out);
      return;
    }
    case "intersection":
      intersect([collect(def.left, value, path, depth, budget), collect(def.right, value, path, depth, budget)], out);
      return;
    default:
      return;
  }
}

function collect(schema: unknown, value: unknown, path: FieldPath, depth: number, budget: WalkBudget): FieldPath[] {
  const found: FieldPath[] = [];
  walk(schema, value, path, found, depth + 1, budget);
  return found;
}

/** The paths every list names (an intersection keeps a key either side declares). */
function intersect(lists: FieldPath[][], out: FieldPath[]): void {
  if (lists.length === 0) return;
  const key = (path: FieldPath) => JSON.stringify(path);
  const [first, ...rest] = lists;
  const others = rest.map((list) => new Set(list.map(key)));
  for (const path of first!) {
    if (others.every((set) => set.has(key(path)))) out.push(path);
  }
}

/** Every key of `value`, at any depth, that `schema` would drop when it parses it. */
export function unknownBodyFields(schema: unknown, value: unknown): FieldPath[] {
  const out: FieldPath[] = [];
  walk(schema, value, [], out, 0, { parses: 0 });
  return out;
}

/**
 * The top-level keys a body schema declares (every option of a union, both
 * sides of an intersection), or null when it accepts any key or is no object:
 * the agent lanes' declared-body-property rule, read from the zod schema.
 */
function declaredTopLevelKeys(schema: unknown): Set<string> | null {
  const node = parsingSchema(schema);
  if (!node) return null;
  const def = node._zod.def;
  if (def.type === "object") {
    const catchall = def.catchall as ZodLike | undefined;
    if (catchall !== undefined && catchall._zod.def.type !== "never") return null;
    return new Set(Object.keys((def.shape ?? {}) as Record<string, unknown>));
  }
  const parts = def.type === "union" ? (def.options as unknown[]) : def.type === "intersection" ? [def.left, def.right] : null;
  if (!parts) return null;
  const declared = new Set<string>();
  for (const part of parts) {
    const keys = declaredTopLevelKeys(part);
    if (!keys) return null;
    keys.forEach((name) => declared.add(name));
  }
  return declared;
}

/** The top-level keys of `value` that `schema` declares nowhere. */
export function undeclaredTopLevelFields(schema: unknown, value: unknown): FieldPath[] {
  if (!isPlainObject(value)) return [];
  const declared = declaredTopLevelKeys(schema);
  if (!declared) return [];
  return Object.keys(value).filter((key) => !declared.has(key)).map((key) => [key]);
}

/**
 * How far a route refuses unknown keys: `deep` everywhere a key would be
 * dropped; `top-level` only keys the body declares nowhere, for the sealed
 * stable app operations, whose nested objects stay open as sealed (adding
 * `additionalProperties: false` narrows a sealed input) while every app,
 * agent and CLI call was already refused an undeclared top-level property.
 */
export type UnknownFieldScope = "deep" | "top-level";

const MAX_ISSUES = 20;
export const UNKNOWN_FIELD_MESSAGE = "This request does not take this field; nothing was saved.";

/**
 * The `validation_error` for unknown keys: one `unrecognized_keys` issue per
 * key, its path ending in the key, then the schema's own issues, so one
 * answer names every problem of the body.
 */
export function unknownFieldsError(paths: readonly FieldPath[], schemaIssues: readonly unknown[] = []): ValidationError {
  const issues: Array<Record<string, unknown>> = paths.map((path) => ({
    code: "unrecognized_keys",
    keys: [String(path[path.length - 1])],
    path,
    message: UNKNOWN_FIELD_MESSAGE,
  }));
  const named = new Set(paths.map((path) => JSON.stringify(path)));
  for (const issue of schemaIssues) {
    if (!isPlainObject(issue)) continue;
    // A `.strict()` object names its unknown keys too: keep each key once.
    if (issue.code === "unrecognized_keys" && Array.isArray(issue.keys) && Array.isArray(issue.path)
      && issue.keys.every((key) => named.has(JSON.stringify([...(issue.path as FieldPath), key])))) continue;
    issues.push(issue);
  }
  return new ValidationError(validationMessage(issues), { issues: issues.slice(0, MAX_ISSUES) });
}

function schemaIssues(schema: unknown, value: unknown): unknown[] {
  if (!isZod(schema)) return [];
  try {
    const result = schema.safeParse(value) as { success: boolean; error?: { issues?: unknown[] } };
    return result.success ? [] : result.error?.issues ?? [];
  } catch {
    return [];
  }
}

const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json/i;

/** Refuses a JSON body with a key the body schema would drop; any other request passes untouched. */
export function unknownBodyFieldGuard(schema: unknown, scope: UnknownFieldScope): MiddlewareHandler {
  return async (c, next) => {
    if (JSON_CONTENT_TYPE.test(c.req.header("content-type") ?? "")) {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        // Malformed or empty: the route's own validator answers it.
        return next();
      }
      const unknown = scope === "deep" ? unknownBodyFields(schema, body) : undeclaredTopLevelFields(schema, body);
      if (unknown.length > 0) {
        // Answered here, as the route's own validators answer a refusal.
        const refusal = errorResponseFromError(unknownFieldsError(unknown, schemaIssues(schema, body)));
        return c.json(refusal.body, refusal.status);
      }
    }
    await next();
  };
}
