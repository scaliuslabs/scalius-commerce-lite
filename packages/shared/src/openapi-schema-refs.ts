/**
 * OpenAPI component schema references in the agent operation manifest.
 *
 * Shared schemas (every `#/components/schemas/*` component, such as the
 * storefront theme document) are emitted once in `AGENT_COMPONENT_SCHEMAS`
 * and referenced by `$ref` from each operation, so a large shared schema is
 * not repeated per operation in the Worker bundle or in an agent's context.
 * Readers that walk a schema resolve a reference where they meet one.
 */

export type ComponentSchemas = Readonly<Record<string, unknown>>;

export const COMPONENT_SCHEMA_REF_PREFIX = "#/components/schemas/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** The component a `$ref` names, or null for anything that is not a component reference. */
export function componentSchemaRefName(value: unknown): string | null {
  if (!isRecord(value) || typeof value.$ref !== "string") return null;
  if (!value.$ref.startsWith(COMPONENT_SCHEMA_REF_PREFIX)) return null;
  return decodeJsonPointerSegment(value.$ref.slice(COMPONENT_SCHEMA_REF_PREFIX.length));
}

/**
 * The schema a node stands for: a component reference is replaced by the
 * component (following chains, with the reference's sibling keywords on
 * top); anything else is returned as is. Shallow: nested references are
 * resolved when a walker reaches them. An unknown component resolves to the
 * reference itself, so a walker sees an opaque node instead of throwing.
 */
export function resolveComponentSchemaRef(value: unknown, schemas: ComponentSchemas): unknown {
  let current = value;
  const seen = new Set<string>();
  for (;;) {
    const name = componentSchemaRefName(current);
    if (name === null || seen.has(name) || schemas[name] === undefined) return current;
    seen.add(name);
    const { $ref: _ref, ...siblings } = current as Record<string, unknown>;
    const target = schemas[name];
    current = Object.keys(siblings).length > 0 && isRecord(target) ? { ...target, ...siblings } : target;
  }
}

/**
 * Every component a value refers to, directly or through other components,
 * as a name-sorted map. Throws on a reference to a missing component, so a
 * manifest can never ship a dangling `$ref`.
 */
export function referencedComponentSchemas(value: unknown, schemas: ComponentSchemas): Record<string, unknown> {
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    const name = componentSchemaRefName(node);
    if (name !== null) {
      if (schemas[name] === undefined) throw new Error(`Unknown OpenAPI component schema ${String(node.$ref)}.`);
      if (!found.has(name)) {
        found.add(name);
        visit(schemas[name]);
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return Object.fromEntries([...found].sort().map((name) => [name, schemas[name]]));
}

/**
 * The value with every component reference replaced by the component, for
 * readers that need one self-contained schema. A component that refers to
 * itself stays a reference at the second visit.
 */
export function inlineComponentSchemaRefs(
  value: unknown,
  schemas: ComponentSchemas,
  visiting: readonly string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => inlineComponentSchemaRefs(item, schemas, visiting));
  }
  if (!isRecord(value)) return value;
  const name = componentSchemaRefName(value);
  if (name !== null) {
    const target = schemas[name];
    if (target === undefined) throw new Error(`Unknown OpenAPI component schema ${String(value.$ref)}.`);
    if (visiting.includes(name)) return value;
    const { $ref: _ref, ...siblings } = value;
    const inlined = inlineComponentSchemaRefs(target, schemas, [...visiting, name]);
    return Object.keys(siblings).length > 0 && isRecord(inlined)
      ? { ...inlined, ...inlineComponentSchemaRefs(siblings, schemas, visiting) as Record<string, unknown> }
      : inlined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = inlineComponentSchemaRefs(child, schemas, visiting);
  }
  return out;
}
