// Where an operation schema carries money: the fields whose name says they
// hold an amount (a price, fee, cost, charge, total, balance, a `*Minor`
// integer) and whose type can hold one. The money-impact census reads it, so
// a write that takes an amount cannot be classified as moving none by
// accident.

type SchemaNode = {
  $ref?: string;
  type?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode | SchemaNode[];
  additionalProperties?: SchemaNode | boolean;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
  requestBody?: { content?: Record<string, { schema?: SchemaNode }> };
  parameters?: Array<{ in?: string; name?: string; schema?: SchemaNode }>;
};

/** A property name that holds an amount of money. */
export const MONEY_FIELD_NAME = /(?:price|amount|fee|fees|cost|costs|charge|total|minor|spend|cash|cashreceived|freeover|tax|balance|credit)$/i;

const COMPONENT_REF = "#/components/schemas/";

function resolve(node: SchemaNode | undefined, components: Readonly<Record<string, unknown>>, seen: ReadonlySet<string>): [SchemaNode, ReadonlySet<string>] | null {
  let current = node;
  let refs = seen;
  while (current?.$ref) {
    if (refs.has(current.$ref) || !current.$ref.startsWith(COMPONENT_REF)) return null;
    refs = new Set([...refs, current.$ref]);
    current = components[current.$ref.slice(COMPONENT_REF.length)] as SchemaNode | undefined;
  }
  return current ? [current, refs] : null;
}

function types(node: SchemaNode, components: Readonly<Record<string, unknown>>, seen: ReadonlySet<string>): Set<unknown> {
  const found = new Set<unknown>([node.type]);
  for (const variant of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
    const resolved = resolve(variant, components, seen);
    if (resolved) for (const type of types(resolved[0], components, resolved[1])) found.add(type);
  }
  return found;
}

/** One money field: its path (`body.items.*.unitPriceMinor`) and its schema. */
export interface MoneyField {
  path: string;
  schema: SchemaNode;
}

function walk(node: SchemaNode | undefined, path: string, components: Readonly<Record<string, unknown>>, seen: ReadonlySet<string>, out: MoneyField[]): void {
  const resolved = resolve(node, components, seen);
  if (!resolved) return;
  const [schema, refs] = resolved;
  for (const variant of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])]) walk(variant, path, components, refs, out);
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const target = resolve(child, components, refs);
    if (target && MONEY_FIELD_NAME.test(key)) {
      const kinds = types(target[0], components, target[1]);
      if (kinds.has("number") || kinds.has("integer") || kinds.has("string")) out.push({ path: `${path}${key}`, schema: target[0] });
    }
    walk(child, `${path}${key}.`, components, refs, out);
  }
  const items = schema.items;
  for (const item of Array.isArray(items) ? items : items ? [items] : []) walk(item, `${path}*.`, components, refs, out);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    walk(schema.additionalProperties, `${path}*.`, components, refs, out);
  }
}

/**
 * The money fields of an operation's input (`{parameters, requestBody}`, as
 * the manifest holds it) or of any JSON Schema.
 */
export function moneyFieldsOf(schema: unknown, components: Readonly<Record<string, unknown>>): MoneyField[] {
  const out: MoneyField[] = [];
  const node = schema as SchemaNode | null;
  if (!node || typeof node !== "object") return out;
  if ("requestBody" in node || "parameters" in node) {
    for (const parameter of node.parameters ?? []) {
      if (parameter.name && MONEY_FIELD_NAME.test(parameter.name) && parameter.schema) {
        const target = resolve(parameter.schema, components, new Set());
        if (target) out.push({ path: `${parameter.in ?? "query"}.${parameter.name}`, schema: target[0] });
      }
    }
    for (const media of Object.values(node.requestBody?.content ?? {})) walk(media.schema, "body.", components, new Set(), out);
    return out;
  }
  walk(node, "", components, new Set(), out);
  return out;
}
