// What a reader receives is what the schema declares, never more. A schema
// projection copies a value keeping only the object keys its JSON Schema
// declares, so a field a handler or resolver adds without declaring it never
// reaches an app or a webhook receiver, and so can never become something one
// depends on. Keys only: values are not validated or coerced, nothing is
// added, and an array keeps every element.
//
// The reading is "keep what any applicable keyword declares", so a declared
// key is never lost to a guess: `allOf` parts, a `$ref` and its siblings all
// apply; of an `anyOf`/`oneOf`, every variant the value matches applies (all
// of them when it matches none). A key is kept when any applicable schema
// declares it (`properties`, a matching `patternProperties`, or
// `additionalProperties`/`unevaluatedProperties` that are not false); a
// free-form object (`type: object` with no key keywords, `true`, `{}` or an
// annotation-only schema) keeps every key. The answer is always a fresh copy
// (every object and array, free-form ones included), so a caller may edit it
// without touching the input.
//
// A schema compiles once into a projector (cache it per operation or type);
// projecting is then one walk of the value. Kept free of zod: the API Worker,
// the dashboard and the SDK read it. `unprojectableKeywords` lists any keyword
// this reading does not know, so a schema that uses one fails its guard test
// instead of losing fields silently.

type SchemaNode = Record<string, unknown>;

/** Resolves a `$ref` to the schema it names (undefined when unknown). */
export type SchemaRefResolver = (ref: string) => unknown;

/** Counts left-out keys without naming them (the cheap check before a log line). */
export interface DropCounter {
  count: number;
}

/**
 * Copies `value` keeping only declared keys. With an array, each left-out
 * key's path (`data.order.secret`, `data.items[].x`) is pushed onto it; with
 * a counter, only counted.
 */
export type SchemaProjector = <T>(value: T, dropped?: string[] | DropCounter) => T;

type Sink = { paths: string[] | null; counter: DropCounter | null };
type Step = (value: unknown, trail: string | null, sink: Sink | null, depth: number) => unknown;

/** The deepest a projected value may nest: far beyond any real answer, well inside the call stack. */
export const MAX_PROJECTION_DEPTH = 500;

/** A value nested deeper than `MAX_PROJECTION_DEPTH`: refused whole rather than overflowing the stack. */
export class SchemaProjectionDepthError extends Error {
  constructor() {
    super(`The value nests deeper than ${MAX_PROJECTION_DEPTH} levels.`);
    this.name = "SchemaProjectionDepthError";
  }
}

const tooDeep = (depth: number) => {
  if (depth > MAX_PROJECTION_DEPTH) throw new SchemaProjectionDepthError();
};

/** Records a left-out key, or a value whose type no applicable schema allows (kept as it is). */
function report(sink: Sink | null, path: string | null): void {
  if (!sink) return;
  if (sink.counter) sink.counter.count += 1;
  if (sink.paths) sink.paths.push(path ?? "(root)");
}

/** Keywords that decide which keys and items a value keeps. */
const STRUCTURE_KEYWORDS = new Set([
  "type", "properties", "patternProperties", "additionalProperties", "unevaluatedProperties",
  "items", "prefixItems", "const", "enum",
]);
/** Keywords that combine or point at other schemas (expanded, never facets themselves). */
const COMBINATOR_KEYWORDS = new Set(["$ref", "allOf", "anyOf", "oneOf"]);
/** Keywords that constrain values or describe them but never add or remove a key. */
const VALUE_KEYWORDS = new Set([
  "required", "nullable", "description", "title", "default", "example", "examples", "format", "pattern",
  "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "propertyNames", "dependentRequired",
  "deprecated", "readOnly", "writeOnly", "contentEncoding", "contentMediaType", "discriminator", "externalDocs",
  "$schema", "$id", "$defs", "definitions", "$comment", "id",
]);

/** The keywords the projection understands; anything else (`not`, `if`, `contains`, ...) is listed by `unprojectableKeywords`. */
export function isProjectionKeyword(keyword: string): boolean {
  return STRUCTURE_KEYWORDS.has(keyword) || COMBINATOR_KEYWORDS.has(keyword) || VALUE_KEYWORDS.has(keyword) || keyword.startsWith("x-");
}

function isRecord(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Assigns without letting a `__proto__` key reach the prototype. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  else target[key] = value;
}

/** A fresh copy of a JSON value: every object and array new, primitives as they are. */
function copy(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object") return value;
  tooDeep(depth);
  if (Array.isArray(value)) return value.map((item) => copy(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) put(out, key, copy((value as Record<string, unknown>)[key], depth + 1));
  return out;
}

/** The JS type of a value, as JSON Schema names it. */
function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function types(facet: SchemaNode): string[] | null {
  if (typeof facet.type === "string") return [facet.type];
  return Array.isArray(facet.type) ? facet.type.filter((type): type is string => typeof type === "string") : null;
}

const KEY_KEYWORDS = ["properties", "patternProperties", "additionalProperties", "unevaluatedProperties"] as const;

/** The JSON types a facet allows, or null when it allows any. */
function allowedTypes(facet: SchemaNode): string[] | null {
  const declared = types(facet);
  const list = declared
    ?? ("const" in facet ? [jsonType(facet.const)]
      : Array.isArray(facet.enum) ? facet.enum.map(jsonType)
      : KEY_KEYWORDS.some((keyword) => facet[keyword] !== undefined) ? ["object"]
      : facet.items !== undefined || facet.prefixItems !== undefined ? ["array"]
      : null);
  if (!list) return null;
  const allowed = new Set(list);
  if (allowed.has("number")) allowed.add("integer");
  if (facet.nullable === true) allowed.add("null");
  return [...allowed];
}

/** Anything goes: `true`, `{}`, or a schema with no structure keyword. */
const ANYTHING: SchemaNode = Object.freeze({});
/** Nothing matches: `false`. */
const NOTHING: SchemaNode = Object.freeze({});

/**
 * A schema flattened: the facets that always apply (the node's own keywords,
 * its `$ref`'s and its `allOf` parts', flattened in turn) and the choice
 * groups (`anyOf`/`oneOf`) of which the variants a value matches apply.
 */
interface Flat {
  facets: SchemaNode[];
  groups: Flat[][];
  /** `nullable: true` on the node or an `allOf` part (OpenAPI 3.0's null), which an annotation-only facet would lose. */
  nullable?: boolean;
}

const hasStructure = (facet: SchemaNode) => facet === NOTHING || Object.keys(facet).some((keyword) => STRUCTURE_KEYWORDS.has(keyword));

/** Matches the regex of a `patternProperties` key; an invalid pattern matches nothing. */
function patternTest(pattern: string): (key: string) => boolean {
  try {
    const regex = new RegExp(pattern, "u");
    return (key) => regex.test(key);
  } catch {
    return () => false;
  }
}

/**
 * Compiles `schema` into a projector (the reading in the header). `$ref`s
 * resolve through `resolveRef`; recursive schemas compile lazily, one level
 * at a time, so recursion through any keyword is safe.
 */
export function schemaProjector(schema: unknown, resolveRef: SchemaRefResolver = () => undefined): SchemaProjector {
  const flats = new WeakMap<object, Flat>();
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  const idOf = (node: object) => {
    let id = ids.get(node);
    if (id === undefined) {
      id = nextId++;
      ids.set(node, id);
    }
    return id;
  };
  const patterns = new Map<string, (key: string) => boolean>();
  const testPattern = (pattern: string, key: string) => {
    let test = patterns.get(pattern);
    if (!test) {
      test = patternTest(pattern);
      patterns.set(pattern, test);
    }
    return test(key);
  };

  /** A schema as a standalone value's schema: one without any structure keyword is ANYTHING. */
  const flatten = (raw: unknown, refs: ReadonlySet<string> = new Set()): Flat => {
    if (raw === false) return { facets: [NOTHING], groups: [] };
    if (!isRecord(raw)) return { facets: [ANYTHING], groups: [] };
    const known = flats.get(raw);
    if (known) return known;
    const facets: SchemaNode[] = [];
    const groups: Flat[][] = [];
    let nullable = raw.nullable === true;
    const absorb = (part: Flat) => {
      facets.push(...part.facets.filter((facet) => facet !== ANYTHING));
      groups.push(...part.groups);
      nullable ||= part.nullable === true;
    };
    const own: SchemaNode = {};
    for (const [keyword, value] of Object.entries(raw)) if (!COMBINATOR_KEYWORDS.has(keyword)) own[keyword] = value;
    facets.push(own);
    if (typeof raw.$ref === "string" && !refs.has(raw.$ref)) absorb(flatten(resolveRef(raw.$ref), new Set([...refs, raw.$ref])));
    for (const part of Array.isArray(raw.allOf) ? raw.allOf : []) absorb(flatten(part, refs));
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const variants = raw[keyword];
      if (Array.isArray(variants) && variants.length > 0) groups.push(variants.map((variant) => flatten(variant, refs)));
    }
    const structured = facets.filter(hasStructure);
    const flat: Flat = { facets: structured.length > 0 || groups.length > 0 ? structured : [ANYTHING], groups, ...(nullable ? { nullable } : {}) };
    if (refs.size === 0) flats.set(raw, flat);
    return flat;
  };

  const resolved = (node: unknown): SchemaNode | null => {
    const seen = new Set<string>();
    let current = node;
    while (isRecord(current) && typeof current.$ref === "string" && !seen.has(current.$ref)) {
      seen.add(current.$ref);
      current = resolveRef(current.$ref);
    }
    return isRecord(current) ? current : null;
  };

  type Matcher = (value: unknown) => boolean;
  const matchers = new WeakMap<Flat, Matcher>();

  /** Whether a value can be an instance of this variant (its facets' types, consts, enums and required keys), compiled once per variant. */
  const matches = (variant: Flat, value: unknown): boolean => {
    let matcher = matchers.get(variant);
    if (!matcher) {
      matcher = compileMatcher(variant);
      matchers.set(variant, matcher);
    }
    return matcher(value);
  };

  const compileMatcher = (variant: Flat): Matcher => {
    if (variant.facets.includes(NOTHING)) return () => false;
    const checks: Matcher[] = [];
    for (const facet of variant.facets) {
      if (facet === ANYTHING) continue;
      const nullable = facet.nullable === true;
      const allowed = types(facet);
      if (allowed) {
        const set = new Set(allowed);
        if (set.has("number")) set.add("integer");
        if (nullable) set.add("null");
        checks.push((value) => set.has(jsonType(value)));
      }
      if ("const" in facet) {
        const constant = facet.const;
        checks.push((value) => value === constant);
      }
      if (Array.isArray(facet.enum)) {
        const values = new Set(facet.enum);
        checks.push((value) => values.has(value) || (nullable && value === null));
      }
      const required = Array.isArray(facet.required) ? facet.required.filter((key): key is string => typeof key === "string") : [];
      if (required.length > 0) checks.push((value) => !isRecord(value) || required.every((key) => Object.hasOwn(value, key)));
      for (const [key, child] of Object.entries(isRecord(facet.properties) ? facet.properties : {})) {
        const property = resolved(child);
        if (!property) continue;
        const propertyNullable = property.nullable === true;
        if ("const" in property) {
          const constant = property.const;
          checks.push((value) => !isRecord(value) || !Object.hasOwn(value, key) || value[key] === constant);
        }
        if (Array.isArray(property.enum)) {
          const values = new Set(property.enum);
          checks.push((value) => !isRecord(value) || !Object.hasOwn(value, key) || values.has(value[key]) || (propertyNullable && value[key] === null));
        }
      }
    }
    return (value) => checks.every((check) => check(value));
  };

  type Discriminator = { key: string; byValue: Map<unknown, number[]> } | null;
  const discriminators = new WeakMap<Flat[], Discriminator>();

  /**
   * A group's discriminator: a property every variant pins (`const` or
   * `enum`), so a value's variants are looked up instead of tried one by one.
   */
  const discriminatorOf = (group: Flat[]): Discriminator => {
    if (discriminators.has(group)) return discriminators.get(group)!;
    let found: Discriminator = null;
    const pinned = (variant: Flat) => {
      const pins = new Map<string, unknown[]>();
      for (const facet of variant.facets) {
        for (const [key, child] of Object.entries(isRecord(facet.properties) ? facet.properties : {})) {
          const property = resolved(child);
          if (property && "const" in property) pins.set(key, [property.const]);
          else if (property && Array.isArray(property.enum)) pins.set(key, property.enum);
        }
      }
      return pins;
    };
    if (group.length > 2 && group.every((variant) => variant.groups.length === 0)) {
      const pins = group.map(pinned);
      for (const key of pins[0]!.keys()) {
        if (!pins.every((each) => each.has(key))) continue;
        const byValue = new Map<unknown, number[]>();
        pins.forEach((each, index) => {
          for (const value of each.get(key)!) byValue.set(value, [...(byValue.get(value) ?? []), index]);
        });
        found = { key, byValue };
        break;
      }
    }
    discriminators.set(group, found);
    return found;
  };

  /** The variants a value matches, as a key: what `applicable` would collect, without collecting it. */
  const choose = (flat: Flat, value: unknown, key: string): string => {
    for (const group of flat.groups) {
      key += "|";
      let any = false;
      const discriminator = isRecord(value) ? discriminatorOf(group) : null;
      const candidates = discriminator && Object.hasOwn(value as object, discriminator.key)
        ? discriminator.byValue.get((value as Record<string, unknown>)[discriminator.key]) ?? []
        : null;
      const indexes = candidates ?? group.map((_, index) => index);
      for (const index of indexes) {
        if (!matches(group[index]!, value)) continue;
        any = true;
        key = choose(group[index]!, value, `${key}${index},`);
      }
      if (!any) for (let index = 0; index < group.length; index += 1) key = choose(group[index]!, value, `${key}${index},`);
    }
    return key;
  };

  /**
   * The facets that apply to a value: the always ones, and of each group the
   * matching variants' (all when none match). `signature` records the choice
   * (each group's matching variants), which names the plan it compiles to.
   */
  const applicable = (flat: Flat, value: unknown, into: SchemaNode[], signature: number[]) => {
    into.push(...flat.facets);
    for (const group of flat.groups) {
      const matching = group.filter((variant) => matches(variant, value));
      signature.push(-1);
      for (const variant of matching.length > 0 ? matching : group) {
        signature.push(group.indexOf(variant));
        applicable(variant, value, into, signature);
      }
    }
    return into;
  };

  const plans = new Map<string, Step>();
  const steps = new Map<string, Step>();

  /** The step for a list of schemas read together (a key several facets declare): what any of them keeps. */
  const compileList = (schemas: readonly unknown[]): Step => {
    const key = schemas.map((schema) => (isRecord(schema) ? idOf(schema) : schema === false ? -1 : 0)).join(",");
    const known = steps.get(key);
    if (known) return known;
    let flat: Flat | null = null;
    let fixed: Step | null = null;
    let allowed: ReadonlySet<string> | null = null;
    const chosen = new Map<string, Step>();
    const step: Step = (value, trail, sink, depth) => {
      if (!flat) {
        const parts = schemas.map((schema) => flatten(schema));
        flat = { facets: parts.flatMap((part) => part.facets), groups: parts.flatMap((part) => part.groups), nullable: parts.some((part) => part.nullable === true) };
        const everyFlat = (each: Flat): Flat[] => [each, ...each.groups.flat().flatMap(everyFlat)];
        const flats = everyFlat(flat);
        const lists = flats.flatMap((each) => each.facets).filter((facet) => facet !== NOTHING).map((facet) => (facet === ANYTHING ? null : allowedTypes(facet)));
        allowed = lists.some((list) => list === null) ? null : new Set([...(lists.flat() as string[]), ...(flats.some((each) => each.nullable) ? ["null"] : [])]);
        if (flat.groups.length === 0) fixed = planFor(flat.facets);
      }
      // A value of a type no applicable schema allows is kept, and reported.
      if (allowed && !allowed.has(jsonType(value))) report(sink, trail === null ? null : `${trail || "(root)"} (type mismatch: ${jsonType(value)})`);
      if (value === null || typeof value !== "object") return value;
      tooDeep(depth);
      if (fixed) return fixed(value, trail, sink, depth);
      // A union: the plan for the variants this value matches, compiled once per choice.
      const choice = choose(flat!, value, "");
      let plan = chosen.get(choice);
      if (!plan) {
        plan = planFor(applicable(flat!, value, [], []));
        chosen.set(choice, plan);
      }
      return plan(value, trail, sink, depth);
    };
    steps.set(key, step);
    return step;
  };

  /** The projection one set of applicable facets makes, compiled once per set. */
  const planFor = (facets: readonly SchemaNode[]): Step => {
    const unique = [...new Set(facets)];
    const key = unique.map((facet) => (facet === ANYTHING ? "*" : facet === NOTHING ? "!" : idOf(facet))).sort().join(",");
    const known = plans.get(key);
    if (known) return known;
    const anything = unique.includes(ANYTHING);
    const objectish = unique.filter((facet) => facet !== ANYTHING && facet !== NOTHING);
    const speaksKeys = (facet: SchemaNode) => KEY_KEYWORDS.some((keyword) => facet[keyword] !== undefined);
    // Free-form: a facet typed object with no key keyword, or no facet that describes an object at all
    // (a value of another declared type is kept whole, never emptied).
    const freeObject = anything
      || objectish.some((facet) => types(facet)?.includes("object") && !speaksKeys(facet))
      || !objectish.some((facet) => types(facet)?.includes("object") || speaksKeys(facet));
    const speaksItems = (facet: SchemaNode) => facet.items !== undefined || facet.prefixItems !== undefined;
    const freeArray = anything
      || objectish.some((facet) => types(facet)?.includes("array") && !speaksItems(facet))
      || !objectish.some((facet) => types(facet)?.includes("array") || speaksItems(facet));
    const declaredKeys = new Set(objectish.flatMap((facet) => (isRecord(facet.properties) ? Object.keys(facet.properties) : [])));
    const hasPatterns = objectish.some((facet) => isRecord(facet.patternProperties));
    const memo = new Map<string, Step | "keep" | null>();
    let otherKeys: Step | "keep" | null | undefined;

    /** What a facet says of a key it does not declare: schemas, keep it as it is, or nothing. */
    const otherOf = (facet: SchemaNode): unknown[] | "keep" | null => {
      const said: unknown[] = [];
      for (const keyword of ["additionalProperties", "unevaluatedProperties"] as const) {
        const value = facet[keyword];
        if (value === undefined || value === false) continue;
        if (value === true || (isRecord(value) && Object.keys(value).length === 0)) return "keep";
        said.push(value);
      }
      return said.length > 0 ? said : null;
    };

    /** A key's answer: every schema any facet gives it (its property, a matching pattern, or its additional keys). */
    const keyStep = (key: string): Step | "keep" | null => {
      const schemas: unknown[] = [];
      let keep = false;
      for (const facet of objectish) {
        const own = isRecord(facet.properties) && Object.hasOwn(facet.properties, key) ? [facet.properties[key]] : [];
        const matched = isRecord(facet.patternProperties)
          ? Object.entries(facet.patternProperties).filter(([pattern]) => testPattern(pattern, key)).map(([, schema]) => schema)
          : [];
        if (own.length + matched.length > 0) {
          schemas.push(...own, ...matched);
          continue;
        }
        const other = otherOf(facet);
        if (other === "keep") keep = true;
        else if (other) schemas.push(...other);
      }
      if (keep) return "keep";
      return schemas.length > 0 ? compileList(schemas) : null;
    };

    const keyAnswer = (key: string): Step | "keep" | null => {
      if (freeObject) return "keep";
      if (declaredKeys.has(key)) {
        if (!memo.has(key)) memo.set(key, keyStep(key));
        return memo.get(key)!;
      }
      // Without patterns every undeclared key has one answer, so a map's keys never grow a cache.
      if (!hasPatterns) {
        if (otherKeys === undefined) otherKeys = keyStep("\u0000");
        return otherKeys;
      }
      return keyStep(key);
    };

    const itemSchemas = (index: number): unknown[] => {
      const schemas: unknown[] = [];
      for (const facet of objectish) {
        const prefix = Array.isArray(facet.prefixItems) ? facet.prefixItems : Array.isArray(facet.items) ? facet.items : null;
        if (prefix && index < prefix.length) schemas.push(prefix[index]);
        else if (isRecord(facet.items) || facet.items === true) schemas.push(facet.items);
      }
      return schemas;
    };
    let uniformItems: Step | null | undefined;
    const uniform = objectish.every((facet) => !Array.isArray(facet.prefixItems) && !Array.isArray(facet.items));

    const plan: Step = (value, trail, sink, depth) => {
      if (Array.isArray(value)) {
        if (freeArray) return copy(value, depth);
        const itemTrail = trail === null ? null : `${trail}[]`;
        return value.map((item, index) => {
          let step: Step | null;
          if (uniform) {
            if (uniformItems === undefined) {
              const schemas = itemSchemas(0);
              uniformItems = schemas.length > 0 ? compileList(schemas) : null;
            }
            step = uniformItems;
          } else {
            const schemas = itemSchemas(index);
            step = schemas.length > 0 ? compileList(schemas) : null;
          }
          // An element no schema describes is kept: a projection removes keys, never elements.
          return step ? step(item, itemTrail, sink, depth + 1) : copy(item, depth + 1);
        });
      }
      if (!isRecord(value)) return value;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const answer = keyAnswer(key);
        const childTrail = trail === null ? null : trail === "" ? key : `${trail}.${key}`;
        if (answer === "keep") put(out, key, copy(value[key], depth + 1));
        else if (answer) put(out, key, answer(value[key], childTrail, sink, depth + 1));
        else report(sink, childTrail);
      }
      return out;
    };
    plans.set(key, plan);
    return plan;
  };

  const root = compileList([schema]);
  return (<T>(value: T, dropped?: string[] | DropCounter): T => {
    const sink: Sink | null = Array.isArray(dropped) ? { paths: dropped, counter: null } : dropped ? { paths: null, counter: dropped } : null;
    return root(value, sink?.paths ? "" : null, sink, 0) as T;
  }) as SchemaProjector;
}

/**
 * Everything in a schema (and the schemas it reaches) that would make the
 * projection keep or drop by accident, as `<path>: <problem>`: a keyword it
 * does not read, a `$ref` that resolves to nothing (it would keep the value
 * whole), and a union variant that matches anything (`true`, `{}` or an
 * annotation-only schema standing in for null, which keeps every key of every
 * value). A guard test holds every output and representation schema to an
 * empty list.
 */
export function unprojectableKeywords(schema: unknown, resolveRef: SchemaRefResolver = () => undefined): string[] {
  const found = new Set<string>();
  const seenRefs = new Set<string>();
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!isRecord(node)) return;
    for (const keyword of Object.keys(node)) if (!isProjectionKeyword(keyword)) found.add(`${path || "(root)"}: ${keyword}`);
    if (typeof node.$ref === "string" && !seenRefs.has(node.$ref)) {
      seenRefs.add(node.$ref);
      const target = resolveRef(node.$ref);
      if (target === undefined) found.add(`${path || "(root)"}: unresolved $ref ${node.$ref}`);
      else walk(target, node.$ref);
    }
    for (const keyword of ["properties", "patternProperties", "$defs", "definitions"] as const) {
      const children = node[keyword];
      if (isRecord(children)) for (const [key, child] of Object.entries(children)) walk(child, `${path}.${key}`);
    }
    for (const keyword of ["additionalProperties", "unevaluatedProperties", "items", "propertyNames"] as const) {
      if (node[keyword] !== undefined && typeof node[keyword] !== "boolean") walk(node[keyword], `${path}.${keyword}`);
    }
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const variants = node[keyword];
      if (!Array.isArray(variants)) continue;
      variants.forEach((variant, index) => {
        const open = variant === true || (isRecord(variant) && !Object.keys(variant).some((key) => STRUCTURE_KEYWORDS.has(key) || COMBINATOR_KEYWORDS.has(key)));
        if (open) found.add(`${path || "(root)"}.${keyword}[${index}]: a union variant that matches anything`);
      });
    }
    for (const keyword of ["prefixItems", "allOf", "anyOf", "oneOf"] as const) {
      if (Array.isArray(node[keyword])) walk(node[keyword], `${path}.${keyword}`);
    }
  };
  walk(schema, "");
  return [...found];
}
