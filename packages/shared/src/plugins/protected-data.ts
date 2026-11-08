// Protected customer data (COMMERCE-HOOKS H5): the buyer contact fields an
// app sees only with the matching scope, field by field (Shopify's protected
// customer data). One classification serves every surface: route output
// schemas mark their fields with `x-scalius-protected`, the event
// representations mark theirs the same way, provider inputs carry only the
// granted categories, and function inputs carry none at all.
//
// `address` is the street: lines, company and dependent locality. The region
// (country, admin area, locality, delivery place ids and names, postal code)
// is not protected: shipping zones, tax and function inputs need it.
//
// Part of the versioned plugin API: categories and their scopes are only
// added, never renamed or removed.
//
// Kept free of zod: the dashboard and the sandbox read it.

import type { ProviderKind } from "./providers/kinds";
import type { PluginScope } from "./scopes";

export const PROTECTED_CUSTOMER_DATA = ["name", "email", "phone", "address"] as const;
export type ProtectedCustomerData = (typeof PROTECTED_CUSTOMER_DATA)[number];

/** The scope that reveals each category (`PLUGIN_SCOPES`). */
export const PROTECTED_DATA_SCOPES = {
  name: "read_customer_names",
  email: "read_customer_emails",
  phone: "read_customer_phones",
  address: "read_customer_addresses",
} as const satisfies Record<ProtectedCustomerData, PluginScope>;
export type ProtectedDataScope = (typeof PROTECTED_DATA_SCOPES)[ProtectedCustomerData];

/** The OpenAPI/JSON Schema keyword that marks a protected field: `"x-scalius-protected": "phone"`. */
export const PROTECTED_FIELD_KEYWORD = "x-scalius-protected";

export function isProtectedCustomerData(value: unknown): value is ProtectedCustomerData {
  return typeof value === "string" && (PROTECTED_CUSTOMER_DATA as readonly string[]).includes(value);
}

/** The categories a set of scopes reveals. */
export function grantedProtectedData(scopes: Iterable<string>): Set<ProtectedCustomerData> {
  const granted = new Set<ProtectedCustomerData>();
  const held = new Set(scopes);
  for (const category of PROTECTED_CUSTOMER_DATA) {
    if (held.has(PROTECTED_DATA_SCOPES[category])) granted.add(category);
  }
  return granted;
}

/** Every category: what staff, the merchant's own agents and a webhook that opted in to everything see. */
export function allProtectedData(): Set<ProtectedCustomerData> {
  return new Set(PROTECTED_CUSTOMER_DATA);
}

/**
 * The protected data each port's input carries. `required`: the provider
 * cannot work without it, so a manifest declaring such a provider must ask
 * for those scopes (base or the provider's feature). `optional`: the host
 * sends a category only when the app holds its scope (payment `buyer`).
 */
export const PROVIDER_PROTECTED_DATA = {
  payment: { required: [], optional: ["name", "email", "phone", "address"] },
  courier: { required: ["name", "phone", "address"], optional: [] },
  sms: { required: ["phone"], optional: [] },
  email: { required: ["email"], optional: [] },
  courier_history: { required: ["phone"], optional: [] },
  messaging: { required: ["phone"], optional: [] },
  address: { required: ["address"], optional: [] },
  tax: { required: [], optional: [] },
  translation: { required: [], optional: [] },
  ai: { required: [], optional: [] },
  push: { required: [], optional: [] },
  search: { required: [], optional: [] },
  fx: { required: [], optional: [] },
  identity: { required: [], optional: [] },
  payout: { required: [], optional: [] },
} as const satisfies Record<ProviderKind, {
  required: readonly ProtectedCustomerData[];
  optional: readonly ProtectedCustomerData[];
}>;

/** The scopes a provider of this kind needs before it can be declared. */
export function providerRequiredScopes(kind: ProviderKind): ProtectedDataScope[] {
  return PROVIDER_PROTECTED_DATA[kind].required.map((category) => PROTECTED_DATA_SCOPES[category]);
}

/** Where each optional category sits in a port's input (payment `createSession`'s `buyer`). */
const PROVIDER_OPTIONAL_FIELDS: Partial<Record<ProviderKind, Record<string, Partial<Record<ProtectedCustomerData, readonly string[]>>>>> = {
  payment: {
    createSession: { name: ["buyer.name"], email: ["buyer.email"], phone: ["buyer.phone"], address: ["buyer.address"] },
  },
};

/**
 * A port input as the app may receive it: the optional protected fields the
 * grant does not cover are removed. A kind's required categories are checked
 * by the caller (an app without them is not approved for that port).
 */
export function projectProviderInput<T>(kind: ProviderKind, operation: string, input: T, granted: ReadonlySet<ProtectedCustomerData>): T {
  const fields = PROVIDER_OPTIONAL_FIELDS[kind]?.[operation];
  if (!fields || typeof input !== "object" || input === null) return input;
  const copy = structuredClone(input) as Record<string, unknown>;
  for (const [category, paths] of Object.entries(fields) as Array<[ProtectedCustomerData, readonly string[]]>) {
    if (granted.has(category)) continue;
    for (const path of paths) {
      const segments = path.split(".");
      let node: unknown = copy;
      for (const segment of segments.slice(0, -1)) node = node && typeof node === "object" ? (node as Record<string, unknown>)[segment] : undefined;
      if (node && typeof node === "object") delete (node as Record<string, unknown>)[segments.at(-1)!];
    }
  }
  return copy as T;
}

// ── Schema-driven projection ─────────────────────────────────────────────

/**
 * One protected field of a JSON Schema: its path (`*` is an array item or a
 * map value) and the categories that reveal it (all of them: a contact that
 * is an email or a phone needs both).
 */
export interface ProtectedPath {
  path: readonly string[];
  categories: readonly ProtectedCustomerData[];
}

/** A marker's categories: one category or a list of them; null when it is not a marker. */
export function protectedMarkerCategories(marker: unknown): ProtectedCustomerData[] | null {
  if (isProtectedCustomerData(marker)) return [marker];
  if (Array.isArray(marker) && marker.length > 0 && marker.every(isProtectedCustomerData)) return [...new Set(marker)];
  return null;
}

type JsonSchemaNode = {
  $ref?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode | JsonSchemaNode[];
  additionalProperties?: JsonSchemaNode | boolean;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  [PROTECTED_FIELD_KEYWORD]?: unknown;
};

/**
 * Every field a JSON Schema marks `x-scalius-protected`, as paths. Union
 * variants contribute all their paths (a path that is absent in a value is
 * simply skipped); `$ref`s resolve through `resolveRef` and stop on a cycle.
 * A path marked more than once (one union variant says email, another phone)
 * needs every category any marking names, and a marked field needs the
 * categories marked anywhere inside it too: the strictest reading wins, so a
 * value never reaches an app that holds only one of its categories.
 */
export function protectedPathsOf(schema: unknown, resolveRef: (ref: string) => unknown = () => undefined): ProtectedPath[] {
  const found = new Map<string, ProtectedPath>();
  // `inside` collects the categories of a marked field's subtree instead of recording paths.
  const walk = (node: unknown, path: string[], refs: ReadonlySet<string>, inside?: Set<ProtectedCustomerData>) => {
    if (!node || typeof node !== "object") return;
    const schemaNode = node as JsonSchemaNode;
    const categories = protectedMarkerCategories(schemaNode[PROTECTED_FIELD_KEYWORD]);
    if (categories && inside) {
      for (const category of categories) inside.add(category);
    } else if (categories && path.length > 0) {
      const key = path.join("\u0000");
      const all = new Set([...(found.get(key)?.categories ?? []), ...categories]);
      walkChildren(schemaNode, path, refs, all);
      found.set(key, { path: [...path], categories: [...all] });
      return;
    }
    walkChildren(schemaNode, path, refs, inside);
  };
  const walkChildren = (schemaNode: JsonSchemaNode, path: string[], refs: ReadonlySet<string>, inside?: Set<ProtectedCustomerData>) => {
    if (typeof schemaNode.$ref === "string" && !refs.has(schemaNode.$ref)) {
      walk(resolveRef(schemaNode.$ref), path, new Set([...refs, schemaNode.$ref]), inside);
    }
    for (const [key, child] of Object.entries(schemaNode.properties ?? {})) walk(child, [...path, key], refs, inside);
    const items = schemaNode.items;
    if (Array.isArray(items)) for (const item of items) walk(item, [...path, "*"], refs, inside);
    else if (items) walk(items, [...path, "*"], refs, inside);
    if (schemaNode.additionalProperties && typeof schemaNode.additionalProperties === "object") {
      walk(schemaNode.additionalProperties, [...path, "*"], refs, inside);
    }
    for (const variant of [...(schemaNode.anyOf ?? []), ...(schemaNode.oneOf ?? []), ...(schemaNode.allOf ?? [])]) walk(variant, path, refs, inside);
  };
  walk(schema, [], new Set());
  return [...found.values()];
}

/**
 * Nulls, in place, every protected field of `value` whose category is not
 * granted, and returns `value`. A projection only: no field is added and no
 * other value changes, so it costs a walk of the marked paths.
 */
export function redactProtectedData<T>(value: T, paths: readonly ProtectedPath[], granted: ReadonlySet<ProtectedCustomerData>): T {
  if (granted.size === PROTECTED_CUSTOMER_DATA.length) return value;
  const visit = (node: unknown, path: readonly string[], depth: number) => {
    if (!node || typeof node !== "object") return;
    const segment = path[depth]!;
    const last = depth === path.length - 1;
    const children: Array<[Record<string, unknown> | unknown[], string | number]> = [];
    if (segment === "*") {
      if (Array.isArray(node)) node.forEach((_, index) => children.push([node, index]));
      else for (const key of Object.keys(node)) children.push([node as Record<string, unknown>, key]);
    } else if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, segment)) {
      children.push([node as Record<string, unknown>, segment]);
    }
    for (const [parent, key] of children) {
      if (last) (parent as Record<string | number, unknown>)[key] = null;
      else visit((parent as Record<string | number, unknown>)[key], path, depth + 1);
    }
  };
  for (const { path, categories } of paths) {
    if (path.length > 0 && !categories.every((category) => granted.has(category))) visit(value, path, 0);
  }
  return value;
}
