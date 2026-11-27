// What a reader receives is what the schema declares, never more. A schema
// projection copies a value keeping only the object keys its JSON Schema
// declares (`properties`, or any key where `additionalProperties` takes one),
// so a field a handler or resolver adds without declaring it never reaches an
// app or a webhook receiver, and so can never become something one depends on.
// Keys only: values are not validated or coerced, and nothing is added.
//
// A schema compiles once into a projector (cache it per operation or type);
// projecting is then one walk of the value. Kept free of zod: the API Worker,
// the dashboard and the SDK read it.

type SchemaNode = Record<string, unknown>;

/** Resolves a `$ref` to the schema it names (undefined when unknown). */
export type SchemaRefResolver = (ref: string) => unknown;

/**
 * Copies `value` keeping only declared keys. With `dropped`, each left-out
 * key's path (`data.order.secret`, `data.items[].x`) is pushed onto it.
 */
export type SchemaProjector = <T>(value: T, dropped?: string[]) => T;

type Step = (value: unknown, trail: string | null, dropped: string[] | null) => unknown;

const KEEP: Step = (value) => value;

function isRecord(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Assigns without letting a `__proto__` key reach the prototype. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  else target[key] = value;
}

const at = (trail: string | null, key: string) => (trail === null ? null : trail === "" ? key : `${trail}.${key}`);

type ObjectPlan = {
  properties: Map<string, Step>;
  /** A step for every other key, `true` to keep them as they are, `false` to leave them out. */
  additional: Step | boolean;
};

function objectStep(plan: ObjectPlan): Step {
  return (value, trail, dropped) => {
    if (!isPlainObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const step = plan.properties.get(key);
      if (step) put(out, key, step(value[key], at(trail, key), dropped));
      else if (typeof plan.additional === "function") put(out, key, plan.additional(value[key], at(trail, key), dropped));
      else if (plan.additional) put(out, key, value[key]);
      else if (dropped) dropped.push(at(trail, key)!);
    }
    return out;
  };
}

/** The JS type of a value, as JSON Schema names it. */
function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/**
 * Compiles `schema` into a projector. Objects: declared `properties` are
 * projected by their schema; any other key is kept only where
 * `additionalProperties` declares it (a schema projects it, `true` keeps it)
 * and an object schema that declares neither is free-form and kept whole.
 * Arrays project each item. `allOf` declares the keys any part declares. A
 * value in an `anyOf`/`oneOf` is projected by the first variant it matches
 * (its type, required keys and the enum or const of each key it has), or by
 * every variant's keys when it matches none. `$ref`s resolve once, through
 * `resolveRef`, and may be recursive.
 */
export function schemaProjector(schema: unknown, resolveRef: SchemaRefResolver = () => undefined): SchemaProjector {
  const byRef = new Map<string, Step>();

  const resolve = (node: unknown, seen = new Set<string>()): SchemaNode | null => {
    if (!isRecord(node)) return null;
    if (typeof node.$ref !== "string") return node;
    if (seen.has(node.$ref)) return null;
    seen.add(node.$ref);
    return resolve(resolveRef(node.$ref), seen);
  };

  /** A node and its `allOf` parts, nested parts flattened. */
  const partsOf = (node: SchemaNode, seen = new Set<SchemaNode>()): SchemaNode[] => {
    if (seen.has(node)) return [];
    seen.add(node);
    const nested = Array.isArray(node.allOf) ? node.allOf.map((part) => resolve(part)).filter((part): part is SchemaNode => part !== null) : [];
    return [node, ...nested.flatMap((part) => partsOf(part, seen))];
  };

  /** The object plan a node declares (its `allOf` parts merged), or null when it declares no object. */
  const planOf = (node: SchemaNode): ObjectPlan | null => {
    const parts = partsOf(node);
    const properties = new Map<string, unknown[]>();
    let additional: unknown;
    for (const part of parts) {
      for (const [key, child] of Object.entries(isRecord(part.properties) ? part.properties : {})) properties.set(key, [...(properties.get(key) ?? []), child]);
      if (additional === undefined) additional = part.additionalProperties;
    }
    const anyProperties = parts.some((part) => isRecord(part.properties));
    if (!anyProperties && additional === undefined && !parts.some((part) => part.type === "object")) return null;
    return {
      properties: new Map([...properties].map(([key, children]) => [key, children.length === 1 ? compile(children[0]) : compile({ allOf: children })])),
      // An object schema with neither properties nor additionalProperties takes any key.
      additional: isRecord(additional) ? compile(additional) : additional === undefined ? !anyProperties : additional !== false,
    };
  };

  const matches = (variant: SchemaNode, value: unknown): boolean => {
    const type = jsonType(value);
    const declared = variant.type ?? (isRecord(variant.properties) ? "object" : undefined);
    if (typeof declared === "string" && declared !== type && !(declared === "number" && type === "integer")) return false;
    if (!isPlainObject(value)) return true;
    if (Array.isArray(variant.required) && !variant.required.every((key) => typeof key === "string" && Object.hasOwn(value, key))) return false;
    for (const [key, child] of Object.entries(isRecord(variant.properties) ? variant.properties : {})) {
      if (!Object.hasOwn(value, key)) continue;
      const property = resolve(child);
      if (!property) continue;
      if (Array.isArray(property.enum) && !property.enum.includes(value[key])) return false;
      if ("const" in property && property.const !== value[key]) return false;
    }
    return true;
  };

  function compile(raw: unknown): Step {
    if (!isRecord(raw)) return KEEP;
    if (typeof raw.$ref === "string") {
      const ref = raw.$ref;
      const known = byRef.get(ref);
      if (known) return known;
      // Recursive schemas: the entry exists before the target compiles.
      let step: Step = KEEP;
      byRef.set(ref, (value, trail, dropped) => step(value, trail, dropped));
      step = compile(resolve(raw));
      return byRef.get(ref)!;
    }
    const variants = [...(Array.isArray(raw.anyOf) ? raw.anyOf : []), ...(Array.isArray(raw.oneOf) ? raw.oneOf : [])];
    if (variants.length > 0) {
      const resolved = variants.map((variant) => resolve(variant)).filter((variant): variant is SchemaNode => variant !== null);
      const steps = resolved.map((variant) => compile(variant));
      if (steps.every((step) => step === KEEP)) return KEEP;
      const fallback = compile({ allOf: resolved });
      return (value, trail, dropped) => {
        if (value === null || typeof value !== "object") return value;
        const index = resolved.findIndex((variant) => matches(variant, value));
        return (index >= 0 ? steps[index]! : fallback)(value, trail, dropped);
      };
    }
    const plan = planOf(raw);
    if (plan) return objectStep(plan);
    if (raw.type === "array" || raw.items !== undefined) {
      const items = raw.items;
      if (Array.isArray(items)) {
        const steps = items.map((item) => compile(item));
        return (value, trail, dropped) => Array.isArray(value)
          ? value.map((item, index) => (steps[index] ?? KEEP)(item, trail === null ? null : `${trail}[${index}]`, dropped))
          : value;
      }
      const step = compile(items);
      if (step === KEEP) return KEEP;
      return (value, trail, dropped) => {
        if (!Array.isArray(value)) return value;
        const itemTrail = trail === null ? null : `${trail}[]`;
        return value.map((item) => step(item, itemTrail, dropped));
      };
    }
    return KEEP;
  }

  const root = compile(schema);
  return (<T>(value: T, dropped?: string[]): T => root(value, dropped ? "" : null, dropped ?? null) as T) as SchemaProjector;
}
