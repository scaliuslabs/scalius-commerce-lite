// App-owned buyer answers (COMMERCE-HOOKS H13): what a buyer gave one app,
// its checkout attributes and its line inputs, reaches that app and the
// store, never another app. A field of a representation or an operation's
// output is marked once, `x-scalius-app-owned`:
//
//   - `"keys"` on a record keyed by `<app id>.<key>` (an order's attributes):
//     an app keeps only its own keys;
//   - `"items"` on a list of objects with an `appId` (an order line's
//     properties): an app keeps the store's own items (`appId` null) and its
//     own, never another app's.
//
// The marked paths are derived once per schema; applying them is a walk of
// the value, never another read. Store readers (the dashboard, agents, the
// store's own webhook endpoints) see every answer.

import { appScopedKeyAppId } from "./ids";

export const APP_OWNED_FIELD_KEYWORD = "x-scalius-app-owned";
export const APP_OWNED_MODES = ["keys", "items"] as const;
export type AppOwnedMode = (typeof APP_OWNED_MODES)[number];

export interface AppOwnedPath {
  path: readonly string[];
  mode: AppOwnedMode;
}

type JsonSchemaNode = {
  $ref?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode | JsonSchemaNode[];
  additionalProperties?: JsonSchemaNode | boolean;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  [APP_OWNED_FIELD_KEYWORD]?: unknown;
};

function isAppOwnedMode(value: unknown): value is AppOwnedMode {
  return typeof value === "string" && (APP_OWNED_MODES as readonly string[]).includes(value);
}

/** Every field a JSON Schema marks `x-scalius-app-owned`, as paths (`*` for a list item or record value). */
export function appOwnedPathsOf(schema: unknown, resolveRef: (ref: string) => unknown = () => undefined): AppOwnedPath[] {
  const found = new Map<string, AppOwnedPath>();
  const walk = (node: unknown, path: string[], refs: ReadonlySet<string>) => {
    if (!node || typeof node !== "object") return;
    const schemaNode = node as JsonSchemaNode;
    const mode = schemaNode[APP_OWNED_FIELD_KEYWORD];
    if (isAppOwnedMode(mode) && path.length > 0) found.set(path.join("\u0000"), { path: [...path], mode });
    if (typeof schemaNode.$ref === "string" && !refs.has(schemaNode.$ref)) {
      walk(resolveRef(schemaNode.$ref), path, new Set([...refs, schemaNode.$ref]));
    }
    for (const [key, child] of Object.entries(schemaNode.properties ?? {})) walk(child, [...path, key], refs);
    const items = schemaNode.items;
    if (Array.isArray(items)) for (const item of items) walk(item, [...path, "*"], refs);
    else if (items) walk(items, [...path, "*"], refs);
    if (schemaNode.additionalProperties && typeof schemaNode.additionalProperties === "object") {
      walk(schemaNode.additionalProperties, [...path, "*"], refs);
    }
    for (const variant of [...(schemaNode.anyOf ?? []), ...(schemaNode.oneOf ?? []), ...(schemaNode.allOf ?? [])]) walk(variant, path, refs);
  };
  walk(schema, [], new Set());
  return [...found.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows, in place, every app-owned field of `value` to what `appId` may
 * see, and returns `value`. Store readers pass `null` and see everything.
 */
export function projectAppOwnedData<T>(value: T, paths: readonly AppOwnedPath[], appId: string | null): T {
  if (appId === null || paths.length === 0) return value;
  const narrow = (field: unknown, mode: AppOwnedMode): unknown => {
    if (mode === "keys") {
      if (!isRecord(field)) return field;
      for (const key of Object.keys(field)) if (appScopedKeyAppId(key) !== appId) delete field[key];
      return field;
    }
    if (!Array.isArray(field)) return field;
    return field.filter((item) => !isRecord(item) || item.appId === null || item.appId === undefined || item.appId === appId);
  };
  const visit = (node: unknown, path: readonly string[], depth: number, mode: AppOwnedMode) => {
    if (!node || typeof node !== "object") return;
    const segment = path[depth]!;
    const last = depth === path.length - 1;
    const entries: Array<[Record<string, unknown> | unknown[], string | number]> = [];
    if (segment === "*") {
      if (Array.isArray(node)) node.forEach((_, index) => entries.push([node, index]));
      else for (const key of Object.keys(node)) entries.push([node as Record<string, unknown>, key]);
    } else if (!Array.isArray(node) && segment in node) {
      entries.push([node as Record<string, unknown>, segment]);
    }
    for (const [parent, key] of entries) {
      const child = (parent as Record<string | number, unknown>)[key];
      if (last) (parent as Record<string | number, unknown>)[key] = narrow(child, mode);
      else visit(child, path, depth + 1, mode);
    }
  };
  // Deepest paths first, so an outer list's narrowing never skips an inner one.
  for (const { path, mode } of [...paths].sort((left, right) => right.path.length - left.path.length)) visit(value, path, 0, mode);
  return value;
}
