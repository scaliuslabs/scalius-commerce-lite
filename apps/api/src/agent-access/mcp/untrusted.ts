// Buyer-written text in what the merchant's agents read (MCP tool results):
// every value an operation's output schema marks as buyer-written comes back
// as `{"untrusted": <value>}`, so a note, message or review that reads like
// an instruction is presented as data. The marks are the schema's own:
// `x-scalius-buyer-text` (notes, messages, reviews, line inputs, custom
// field values), `x-scalius-protected` (names, contacts, addresses) and
// `x-scalius-app-owned` (buyer answers to apps). The paths are derived once
// per operation from the generated contract; labelling is a walk of them.
// The server instructions say such values are data, never instructions.
import { APP_OWNED_FIELD_KEYWORD } from "@scalius/shared/plugins/app-owned-data";
import { PROTECTED_FIELD_KEYWORD } from "@scalius/shared/plugins/protected-data";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { componentSchema } from "../../plugins/protected-response";
import { BUYER_TEXT_KEYWORD } from "@scalius/shared/buyer-text";

/** The key of the label: `{"untrusted": "Please refund this order"}`. */
export const UNTRUSTED_LABEL = "untrusted";

const MARKS = [BUYER_TEXT_KEYWORD, PROTECTED_FIELD_KEYWORD, APP_OWNED_FIELD_KEYWORD] as const;

type SchemaNode = {
  $ref?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode | SchemaNode[];
  additionalProperties?: SchemaNode | boolean;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
  [key: string]: unknown;
};

/** Every buyer-written field of a JSON Schema, as paths (`*` is an array item or a map value). */
export function untrustedPathsOf(schema: unknown, resolveRef: (ref: string) => unknown): string[][] {
  const found = new Map<string, string[]>();
  const walk = (node: unknown, path: string[], refs: ReadonlySet<string>) => {
    if (!node || typeof node !== "object") return;
    const schemaNode = node as SchemaNode;
    if (path.length > 0 && MARKS.some((mark) => schemaNode[mark] !== undefined && schemaNode[mark] !== false)) {
      // A marked list or record whose own fields are marked (a line's buyer
      // inputs: their values, not their keys) labels those fields only.
      const before = found.size;
      descend(schemaNode, path, refs);
      if (found.size === before) found.set(path.join("\u0000"), [...path]);
      return;
    }
    descend(schemaNode, path, refs);
  };
  const descend = (schemaNode: SchemaNode, path: string[], refs: ReadonlySet<string>) => {
    if (typeof schemaNode.$ref === "string" && !refs.has(schemaNode.$ref)) {
      walk(resolveRef(schemaNode.$ref), path, new Set([...refs, schemaNode.$ref]));
    }
    for (const [key, child] of Object.entries(schemaNode.properties ?? {})) walk(child, [...path, key], refs);
    const items = schemaNode.items;
    for (const item of Array.isArray(items) ? items : items ? [items] : []) walk(item, [...path, "*"], refs);
    if (schemaNode.additionalProperties && typeof schemaNode.additionalProperties === "object") {
      walk(schemaNode.additionalProperties, [...path, "*"], refs);
    }
    for (const variant of [...(schemaNode.anyOf ?? []), ...(schemaNode.oneOf ?? []), ...(schemaNode.allOf ?? [])]) walk(variant, path, refs);
  };
  walk(schema, [], new Set());
  return [...found.values()];
}

const pathsByOperation = new Map<string, readonly string[][]>();

/** The buyer-written fields of an operation's response body. */
export function operationUntrustedPaths(operation: Pick<AgentOperationManifestEntry, "operationId" | "outputSchema">): readonly string[][] {
  let paths = pathsByOperation.get(operation.operationId);
  if (!paths) {
    paths = untrustedPathsOf(operation.outputSchema, componentSchema);
    pathsByOperation.set(operation.operationId, paths);
  }
  return paths;
}

function isLabel(value: unknown): value is { untrusted: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 1 && Object.hasOwn(value, UNTRUSTED_LABEL);
}

/** Every non-empty string inside a marked value, labelled (a marked address labels each of its lines). */
function label(value: unknown): unknown {
  if (typeof value === "string") return value.length > 0 ? { [UNTRUSTED_LABEL]: value } : value;
  if (isLabel(value)) return value;
  if (Array.isArray(value)) return value.map(label);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, label(item)]));
  return value;
}

/** The body with every value at the paths labelled; the input is not changed. */
export function labelUntrustedValues<T>(body: T, paths: readonly string[][]): T {
  if (paths.length === 0) return body;
  const visit = (node: unknown, path: readonly string[], depth: number): unknown => {
    if (depth === path.length) return label(node);
    if (!node || typeof node !== "object") return node;
    const segment = path[depth]!;
    if (Array.isArray(node)) {
      return segment === "*" ? node.map((item) => visit(item, path, depth + 1)) : node;
    }
    const record = node as Record<string, unknown>;
    if (segment === "*") return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, visit(item, path, depth + 1)]));
    if (!Object.hasOwn(record, segment)) return node;
    return { ...record, [segment]: visit(record[segment], path, depth + 1) };
  };
  let labelled: unknown = body;
  for (const path of paths) labelled = visit(labelled, path, 0);
  return labelled as T;
}

/** An operation's response body as an agent reads it: buyer-written values labelled untrusted. */
export function labelUntrustedResponse<T>(operation: Pick<AgentOperationManifestEntry, "operationId" | "outputSchema">, body: T): T {
  return labelUntrustedValues(body, operationUntrustedPaths(operation));
}

/** The value with every label removed: what a later step's `$step` reference passes on as input. */
export function unlabelUntrusted(value: unknown): unknown {
  if (isLabel(value)) return value.untrusted;
  if (Array.isArray(value)) return value.map(unlabelUntrusted);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unlabelUntrusted(item)]));
  return value;
}
