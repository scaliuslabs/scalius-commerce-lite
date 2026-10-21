// The stable app API (`x-scalius-agent.stability: "stable"`): the operations a
// third-party app may call through `ctx.api.call`. This gate keeps them a
// contract:
//
//   1. every stable operation is callable by a third-party app under some
//      scope, and every scope reaches a stable operation (or a bridge
//      capability);
//   2. against the committed snapshot (`stable-operations.snapshot.json`)
//      no stable operation disappears, moves, loses a scope that covered it
//      or tightens its idempotency/revision rules, and no request or response
//      schema changes in a breaking way (`schema-compat.ts`);
//   3. the snapshot equals the current contract exactly, so an additive
//      change is reviewed: accept it with `vitest run -u` on this file.
//
// The snapshot is keyed by app name (`orders.get`, plugins/app-operations.ts):
// the one name an app passes to `ctx.api.call`, sealed with its contract.
//
// A breaking change needs a new operation (or a new plugin API version), not
// an edited snapshot. Before the v2 lock a deliberate break (a security fix)
// is accepted only by an entry in `stable-operations.breaks.json` naming the
// exact change and the committed snapshot's fingerprint.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { effectivePluginPermissions } from "@scalius/core/modules/plugins";
import { PLUGIN_SCOPE_NAMES, PROTECTED_FIELD_KEYWORD, isProtectedDataScope, type PluginScope } from "@scalius/shared/plugins";
import { protectedMarkerCategories } from "@scalius/shared/plugins/protected-data";
import { eventDataTruncation } from "@scalius/shared/events";
import { AGENT_COMPONENT_SCHEMAS, AGENT_OPERATIONS } from "../generated/agent-operations.gen";
import { isOperationAvailableToPlugin, pluginRbacSatisfied } from "../plugins/authority";
import { appOperationName, resolveAppOperation } from "../plugins/app-operations";
import type { AgentOperationManifestEntry } from "./agent-operation-manifest";
import { referencedComponentSchemas } from "@scalius/shared/openapi-schema-refs";
import { inputBreakingChanges, schemaBreakingChanges } from "@scalius/shared/schema-compat";
import { snapshotFingerprint, unacknowledgedBreaks, type AbiBreakAcknowledgement } from "@scalius/shared/plugins/abi-compat";

const SNAPSHOT_NAME = "stable-operations.snapshot.json";
const SNAPSHOT_FILE = new URL(`./${SNAPSHOT_NAME}`, import.meta.url);
const BREAKS_NAME = "stable-operations.breaks.json";

/**
 * Accepted breaks (`abi-compat.ts` rules): each names its exact change and the
 * fingerprint of the snapshot it breaks from, so an entry never pre-accepts a
 * later break and `vitest -u` alone accepts none.
 */
function acknowledgedBreaks(): AbiBreakAcknowledgement[] {
  return JSON.parse(readFileSync(new URL(`./${BREAKS_NAME}`, import.meta.url), "utf8")) as AbiBreakAcknowledgement[];
}

/**
 * Scopes that reach no operation by themselves: bridge capabilities
 * (`ctx.messaging` marketing sends, messages to any address) and the
 * protected customer data scopes, which reveal marked response fields of
 * operations other scopes reach.
 */
const BRIDGE_ONLY_SCOPES: ReadonlySet<PluginScope> = new Set([
  "write_marketing",
  "send_messages_any",
  ...PLUGIN_SCOPE_NAMES.filter((scope) => isProtectedDataScope(scope)),
]);

/**
 * The app's view of a schema: a field marked `x-scalius-protected` reads null
 * without its scope, so the sealed contract says so (`nullable`).
 */
function appView<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(appView) as T;
  if (!schema || typeof schema !== "object") return schema;
  const node = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, appView(value)]));
  if (PROTECTED_FIELD_KEYWORD in node && !node.$ref) node.nullable = true;
  return node as T;
}

interface StableOperationSnapshot {
  /** The operation the app name resolves to (its OpenAPI operationId); not part of the app contract. */
  operationId: string;
  method: string;
  path: string;
  risk: string;
  idempotency: string;
  revision: string;
  /** Every scope that alone lets a third-party app call it. */
  scopes: PluginScope[];
  input: unknown;
  output: unknown;
}

interface StableSnapshot {
  operations: Record<string, StableOperationSnapshot>;
  components: Record<string, unknown>;
}

function coveringScopes(operation: AgentOperationManifestEntry): PluginScope[] {
  return PLUGIN_SCOPE_NAMES.filter((scope) => pluginRbacSatisfied(operation.rbac, effectivePluginPermissions({ scopes: [scope] })));
}

const stable = AGENT_OPERATIONS.filter((operation) => operation.stability === "stable");

function currentSnapshot(): StableSnapshot {
  const operations = Object.fromEntries(stable.map((operation) => [appOperationName(operation.operationId) ?? operation.operationId, {
    operationId: operation.operationId,
    method: operation.method,
    path: operation.pathTemplate,
    risk: operation.risk,
    idempotency: operation.idempotency,
    revision: operation.revision,
    scopes: coveringScopes(operation),
    input: operation.inputSchema,
    output: appView(operation.outputSchema),
  } satisfies StableOperationSnapshot]));
  return {
    operations,
    components: appView(referencedComponentSchemas(stable.map((operation) => [operation.inputSchema, operation.outputSchema]), AGENT_COMPONENT_SCHEMAS)),
  };
}

function committedSnapshot(): StableSnapshot | null {
  try {
    return JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) as StableSnapshot;
  } catch {
    return null;
  }
}

const TIGHTER: Record<string, readonly string[]> = {
  idempotency: ["none", "supported", "required"],
  revision: ["none", "optional", "required"],
};

/** Every breaking difference from `before` to `after`, one line each. */
function stableBreakingChanges(before: StableSnapshot, after: StableSnapshot): string[] {
  const problems: string[] = [];
  const components = { before: before.components, after: after.components };
  for (const [operationId, was] of Object.entries(before.operations)) {
    const now = after.operations[operationId];
    if (!now) {
      problems.push(`${operationId}: removed from the stable app API.`);
      continue;
    }
    if (was.method !== now.method || was.path !== now.path) problems.push(`${operationId}: moved from ${was.method} ${was.path} to ${now.method} ${now.path}.`);
    for (const scope of was.scopes) {
      if (!now.scopes.includes(scope)) problems.push(`${operationId}: the ${scope} scope no longer covers it.`);
    }
    for (const field of ["idempotency", "revision"] as const) {
      const order = TIGHTER[field]!;
      if (order.indexOf(now[field]) > order.indexOf(was[field]) && now[field] === "required") {
        problems.push(`${operationId}: ${field} is now required.`);
      }
    }
    problems.push(...inputBreakingChanges(was.input, now.input, components).map((line) => `${operationId} input ${line}`));
    problems.push(...schemaBreakingChanges(was.output, now.output, "response", components).map((line) => `${operationId} output ${line}`));
  }
  return problems;
}

/** A field name that names an amount of money (`totalMinor`, `price`, `shippingCharge`...). */
const MONEY_KEY = /(price|amount|subtotal|cost|fee|charge|balance|paid|due|refund|cash|spent|revenue|discount|shipping|tax|total)/iu;
/** Names that look like money but count, time or rank something. */
const NOT_MONEY_KEY = /(count|pages|orders|characters|percent|bps|rate|quantity|days|weight|position|priority|version|revision|items|at)$|^total$/iu;
const CURRENCY_KEY = /^(currency|currencyCode|[a-z]+Currency)$/u;

type SchemaNode = Record<string, unknown>;

/**
 * Every place a stable schema carries money in a way the app API does not
 * allow: a decimal or non-integer amount anywhere, or a returned `*Minor`
 * amount with no currency on its object or an enclosing one.
 */
function moneyProblems(operations: readonly AgentOperationManifestEntry[], components: Record<string, unknown> = AGENT_COMPONENT_SCHEMAS as Record<string, unknown>): string[] {
  const problems = new Set<string>();
  const resolve = (node: unknown): SchemaNode | null => {
    if (!node || typeof node !== "object") return null;
    const ref = (node as { $ref?: unknown }).$ref;
    return typeof ref === "string" ? resolve(components[ref.replace("#/components/schemas/", "")]) : node as SchemaNode;
  };
  const walk = (label: string, node: unknown, path: string[], currencyInReach: boolean, output: boolean, refs: Set<string>) => {
    const ref = node && typeof node === "object" ? (node as { $ref?: unknown }).$ref : undefined;
    if (typeof ref === "string") {
      if (refs.has(ref)) return;
      refs = new Set([...refs, ref]);
    }
    const schema = resolve(node);
    if (!schema) return;
    const key = path.filter((segment) => segment !== "*").at(-1);
    if (key && (schema.type === "number" || schema.type === "integer") && MONEY_KEY.test(key) && !NOT_MONEY_KEY.test(key)) {
      if (!key.endsWith("Minor") || schema.type !== "integer") problems.add(`${label} ${path.join(".")}: money is an integer *Minor field.`);
      else if (output && !currencyInReach) problems.add(`${label} ${path.join(".")}: no currency beside this amount.`);
    }
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    const reach = currencyInReach || Object.keys(properties).some((name) => CURRENCY_KEY.test(name));
    for (const [child, value] of Object.entries(properties)) walk(label, value, [...path, child], reach, output, refs);
    if (schema.items) walk(label, schema.items, [...path, "*"], reach, output, refs);
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") walk(label, schema.additionalProperties, [...path, "*"], reach, output, refs);
    for (const variant of [...((schema.anyOf ?? []) as unknown[]), ...((schema.oneOf ?? []) as unknown[]), ...((schema.allOf ?? []) as unknown[])]) {
      walk(label, variant, path, reach, output, refs);
    }
  };
  for (const operation of operations) {
    const input = (operation.inputSchema ?? {}) as { parameters?: { name: string; schema?: unknown }[]; requestBody?: { content?: Record<string, { schema?: unknown }> } };
    for (const parameter of input.parameters ?? []) walk(`${operation.operationId} input`, parameter.schema, [parameter.name], true, false, new Set());
    for (const media of Object.values(input.requestBody?.content ?? {})) walk(`${operation.operationId} input`, media.schema, [], true, false, new Set());
    walk(`${operation.operationId} output`, operation.outputSchema, [], false, true, new Set());
  }
  return [...problems];
}

/** A field name that names an instant (`createdAt`, `failingSince`, `startsAtEpochSeconds`). */
const TIME_KEY = /(At|Since|Until|EpochSeconds|Epoch)$/u;
/** Names that end like a time but are not one. */
const NOT_TIME_KEY = /^compareAt/u;

/**
 * Every place a stable schema carries an instant in another form than an
 * ISO 8601 `date-time` string (or null): an integer, epoch seconds, a bare
 * string or a union of forms.
 */
function timeProblems(operations: readonly AgentOperationManifestEntry[], components: Record<string, unknown> = AGENT_COMPONENT_SCHEMAS as Record<string, unknown>): string[] {
  const problems = new Set<string>();
  const resolve = (node: unknown): SchemaNode | null => {
    if (!node || typeof node !== "object") return null;
    const ref = (node as { $ref?: unknown }).$ref;
    return typeof ref === "string" ? resolve(components[ref.replace("#/components/schemas/", "")]) : node as SchemaNode;
  };
  /** The non-null forms a schema allows. */
  const forms = (schema: SchemaNode): SchemaNode[] => {
    const variants = [...((schema.anyOf ?? []) as unknown[]), ...((schema.oneOf ?? []) as unknown[])].map(resolve).filter((each): each is SchemaNode => each !== null);
    if (variants.length > 0) return variants.flatMap(forms);
    return schema.type === "null" ? [] : [schema];
  };
  const isIso = (schema: SchemaNode) => forms(schema).length > 0 && forms(schema).every((form) => form.type === "string" && form.format === "date-time");
  const walk = (label: string, node: unknown, path: string[], refs: Set<string>) => {
    const ref = node && typeof node === "object" ? (node as { $ref?: unknown }).$ref : undefined;
    if (typeof ref === "string") {
      if (refs.has(ref)) return;
      refs = new Set([...refs, ref]);
    }
    const schema = resolve(node);
    if (!schema) return;
    const key = path.filter((segment) => segment !== "*").at(-1);
    if (key && TIME_KEY.test(key) && !NOT_TIME_KEY.test(key) && !isIso(schema)) problems.add(`${label} ${path.join(".")}: an instant is an ISO 8601 date-time string.`);
    for (const [child, value] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) walk(label, value, [...path, child], refs);
    if (schema.items) walk(label, schema.items, [...path, "*"], refs);
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") walk(label, schema.additionalProperties, [...path, "*"], refs);
    for (const variant of [...((schema.anyOf ?? []) as unknown[]), ...((schema.oneOf ?? []) as unknown[]), ...((schema.allOf ?? []) as unknown[])]) {
      walk(label, variant, path, refs);
    }
  };
  for (const operation of operations) {
    const input = (operation.inputSchema ?? {}) as { parameters?: { name: string; schema?: unknown }[]; requestBody?: { content?: Record<string, { schema?: unknown }> } };
    for (const parameter of input.parameters ?? []) walk(`${operation.operationId} input`, parameter.schema, [parameter.name], new Set());
    for (const media of Object.values(input.requestBody?.content ?? {})) walk(`${operation.operationId} input`, media.schema, [], new Set());
    walk(`${operation.operationId} output`, operation.outputSchema, [], new Set());
  }
  return [...problems];
}

/** Page navigation other than one cursor: request parameters and response keys. */
const PAGE_PARAMETERS = new Set(["page", "pageSize", "offset", "after", "before"]);
const PAGE_RESPONSE_KEYS = new Set(["pagination", "page", "totalPages", "hasMore", "hasNextPage", "nextAfter", "nextOffset", "offset", "pageInfo"]);

/**
 * Every stable list pages one way: `cursor` + `limit` in, `{ <plural>,
 * nextCursor }` out (`nextCursor: string | null`). A bounded lookup (a
 * `limit` with no cursor: the top tags, one tree level) returns at most
 * `limit` and no paging.
 */
function paginationProblems(operations: readonly AgentOperationManifestEntry[], components: Record<string, unknown> = AGENT_COMPONENT_SCHEMAS as Record<string, unknown>): string[] {
  const problems: string[] = [];
  const resolve = (node: unknown): SchemaNode | null => {
    if (!node || typeof node !== "object") return null;
    const ref = (node as { $ref?: unknown }).$ref;
    return typeof ref === "string" ? resolve(components[ref.replace("#/components/schemas/", "")]) : node as SchemaNode;
  };
  for (const operation of operations) {
    const input = (operation.inputSchema ?? {}) as { parameters?: { name: string; in: string }[] };
    const query = new Set((input.parameters ?? []).filter((parameter) => parameter.in === "query").map((parameter) => parameter.name));
    for (const name of query) if (PAGE_PARAMETERS.has(name)) problems.push(`${operation.operationId}: pages by ${name}; take cursor and limit.`);
    const envelope = resolve(operation.outputSchema);
    const data = resolve(((envelope?.properties ?? {}) as Record<string, unknown>).data);
    const keys = Object.keys((data?.properties ?? {}) as Record<string, unknown>);
    for (const key of keys) if (PAGE_RESPONSE_KEYS.has(key)) problems.push(`${operation.operationId}: returns ${key}; return nextCursor.`);
    const pages = query.has("cursor") || keys.includes("nextCursor");
    if (pages && !(query.has("cursor") && query.has("limit") && keys.includes("nextCursor"))) {
      problems.push(`${operation.operationId}: a cursor list takes cursor and limit and returns nextCursor.`);
    }
  }
  return problems;
}

describe("the stable app API", () => {
  it("is a deliberate, coherent set every third-party app can reach through a scope", () => {
    expect(stable.length).toBeGreaterThanOrEqual(100);
    const unreachable = stable
      .filter((operation) => !isOperationAvailableToPlugin(operation, false) || coveringScopes(operation).length === 0)
      .map((operation) => operation.operationId);
    expect(unreachable).toEqual([]);
    const idle = PLUGIN_SCOPE_NAMES.filter((scope) => !BRIDGE_ONLY_SCOPES.has(scope)
      && !stable.some((operation) => coveringScopes(operation).includes(scope)));
    expect(idle).toEqual([]);
  });

  it("marks every buyer contact field it returns as protected customer data, beta operations first-party apps call included", () => {
    // Field names that carry a buyer's contact details wherever they appear,
    // and `name` under a customer or address record.
    const CONTACT_KEYS = new Set([
      "customerName", "customerPhone", "customerEmail", "customerWhatsapp",
      "shippingName", "shippingPhone", "shippingAddress", "shippingAddressLine2", "shippingCompany", "shippingDependentLocality",
      "billingName", "billingPhone", "billingAddress", "billingAddressLine2", "billingCompany", "billingDependentLocality",
      "email", "phone", "phoneRaw", "line1", "line2", "company", "dependentLocality", "contact", "consentContact", "latestOrderName",
      "recipientName", "recipientPhone", "recipientAddress",
    ]);
    const PERSON_CONTAINERS = new Set(["customers", "customer", "customerRecord", "addresses", "address", "defaultAddress", "mergedInto", "relatedCustomer"]);
    // The store's own contact details, not a buyer's.
    const STORE_OWNED = new Set(["dashboard.inventory_locations.list", "dashboard.settings.business_get"]);
    // The store's own details inside a buyer document (an invoice's seller block).
    const STORE_OWNED_PATHS = ["data.businessInfo"];
    const resolve = (node: unknown): Record<string, unknown> | null => {
      if (!node || typeof node !== "object") return null;
      const ref = (node as { $ref?: unknown }).$ref;
      return typeof ref === "string"
        ? resolve((AGENT_COMPONENT_SCHEMAS as Record<string, unknown>)[ref.replace("#/components/schemas/", "")])
        : node as Record<string, unknown>;
    };
    const unmarked: string[] = [];
    const walk = (operationId: string, node: unknown, path: string[], refs: Set<string>) => {
      const ref = node && typeof node === "object" ? (node as { $ref?: unknown }).$ref : undefined;
      if (typeof ref === "string") {
        if (refs.has(ref)) return;
        refs = new Set([...refs, ref]);
      }
      const schema = resolve(node);
      if (!schema) return;
      const key = path.at(-1);
      const parent = path.filter((segment) => segment !== "*").at(-2);
      const contact = key !== undefined && (CONTACT_KEYS.has(key) || (key === "name" && parent !== undefined && PERSON_CONTAINERS.has(parent))
        || (key === "name" && path.join(".") === "data" + ".name" && operationId.startsWith("dashboard.customers.")));
      // An object (an address, a contact block) is checked through its fields.
      const storeOwned = STORE_OWNED_PATHS.some((prefix) => path.join(".").startsWith(`${prefix}.`));
      if (contact && !storeOwned && !protectedMarkerCategories(schema[PROTECTED_FIELD_KEYWORD]) && schema.type !== "boolean" && schema.type !== "object") {
        unmarked.push(`${operationId} ${path.join(".")}`);
      }
      for (const [child, value] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) walk(operationId, value, [...path, child], refs);
      if (schema.items) walk(operationId, schema.items, [...path, "*"], refs);
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") walk(operationId, schema.additionalProperties, [...path, "*"], refs);
      for (const variant of [...((schema.anyOf ?? []) as unknown[]), ...((schema.oneOf ?? []) as unknown[]), ...((schema.allOf ?? []) as unknown[])]) {
        walk(operationId, variant, path, refs);
      }
    };
    // Beta operations only first-party apps may call, which return buyer
    // contact details (audit R2 F10): marked before any is promoted to stable.
    const FIRST_PARTY_CONTACT_OPERATIONS = [
      "dashboard.orders.invoice_get",
      "dashboard.orders.invoice_issue",
      "dashboard.customers.history",
      "dashboard.conversations.context",
      "dashboard.conversations.list",
      "dashboard.conversations.get",
      "dashboard.gift_cards.get",
      "dashboard.search.global",
      "dashboard.home.summary",
    ];
    const beta = FIRST_PARTY_CONTACT_OPERATIONS.map((operationId) => {
      const operation = AGENT_OPERATIONS.find((candidate) => candidate.operationId === operationId);
      expect(operation, operationId).toBeDefined();
      return operation!;
    });
    for (const operation of [...stable, ...beta]) {
      if (STORE_OWNED.has(operation.operationId)) continue;
      walk(operation.operationId, operation.outputSchema, [], new Set());
    }
    expect([...new Set(unmarked)]).toEqual([]);
  });

  it("names every operation once, by resource and verb, never by the dashboard's route tree", () => {
    for (const operation of stable) {
      const name = appOperationName(operation.operationId);
      expect(name, operation.operationId).toMatch(/^(?!dashboard\.|resources\.)[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u);
      expect(resolveAppOperation(name!)?.operationId).toBe(operation.operationId);
    }
    // Where the dashboard has its own operation beside the resource, the resource owns the name.
    expect(resolveAppOperation("products.create")?.operationId).toBe("dashboard.resources.products.create");
    expect(resolveAppOperation("orders.list")?.operationId).toBe("dashboard.resources.orders.list");
    expect(appOperationName("dashboard.products.create")).toBeNull();
    expect(resolveAppOperation("dashboard.resources.orders.get")).toBeNull();
    expect(resolveAppOperation("storefront.products.list")).toBeNull();
  });

  it("never reaches people, credentials, webhooks or apps", () => {
    for (const operation of stable) {
      expect(operation.operationId).not.toMatch(/^dashboard\.(account|team|agent_access|apps|webhooks|security)\./);
    }
  });

  it("locks the app API only: every storefront operation is beta", () => {
    const storefront = AGENT_OPERATIONS.filter((operation) => operation.surface === "storefront");
    expect(storefront.length).toBeGreaterThan(0);
    expect(storefront.filter((operation) => operation.stability !== "beta" && operation.exposure === "execute").map((operation) => operation.operationId)).toEqual([]);
  });

  it("pages every list one way: cursor and limit in, nextCursor out", () => {
    expect(paginationProblems(stable)).toEqual([]);
  });

  it("carries every instant as one ISO 8601 date-time string", () => {
    expect(timeProblems(stable)).toEqual([]);
  });

  it("carries money only as integer minor units, with a currency beside every amount it returns", () => {
    expect(moneyProblems(stable)).toEqual([]);
  });

  it("has one retry contract: the Idempotency-Key header on every mutation, and no body key", () => {
    const mutations = stable.filter((operation) => operation.risk !== "read");
    expect(mutations.length).toBeGreaterThan(40);
    expect(mutations.filter((operation) => operation.idempotency === "none").map((operation) => operation.operationId)).toEqual([]);
    for (const operation of mutations) {
      const input = operation.inputSchema as { parameters?: { name: string; in: string; schema?: { pattern?: string; maxLength?: number } }[] };
      const header = input.parameters?.find((parameter) => parameter.in === "header" && parameter.name === "idempotency-key");
      expect(header?.schema, operation.operationId).toMatchObject({ pattern: "^[\\x20-\\x7E]{8,200}$", maxLength: 200 });
    }
    const sealed = JSON.stringify(Object.fromEntries(Object.entries(currentSnapshot().operations).map(([id, operation]) => [id, operation.input])));
    for (const field of ["requestKey", "operationKey"]) expect(sealed.includes(`"${field}"`), field).toBe(false);
  });

  it("takes a revision precondition on every write that is not a create", () => {
    // No revision to compare yet: custom field values (each PUT checks the
    // definitions' revisions), customers (no revision column; adding one
    // touches every checkout write), the place import (an additive upsert
    // of a dataset) and publications (outside the product revision by
    // design). An optional precondition added later is additive.
    const WITHOUT_REVISION = new Set([
      ...["brand", "category", "collection", "customer", "order", "page", "product", "variant"].map((owner) => `dashboard.custom_fields.set_${owner}_values`),
      "dashboard.customers.update",
      "dashboard.customers.tags_set",
      "dashboard.delivery_locations.import",
      "dashboard.products.publications_set",
      // Bulk runs of tags and publications: neither has a revision to compare.
      "dashboard.resources.customers.bulk_tag",
      "dashboard.resources.products.bulk_publish",
      // Permanent delete of an app's own trashed items: only trashed items
      // it created qualify, and a gone item reads not_found, so a repeat is
      // harmless; a restore in between makes the item not_in_trash.
      "dashboard.resources.app_content.delete",
    ]);
    const creates = /\.(create|batch_create|import_url)$/u;
    const unguarded = stable
      .filter((operation) => operation.risk !== "read" && !creates.test(operation.operationId) && operation.revision === "none")
      .map((operation) => operation.operationId);
    expect(unguarded.filter((id) => !WITHOUT_REVISION.has(id))).toEqual([]);
    expect([...WITHOUT_REVISION].filter((id) => !unguarded.includes(id))).toEqual([]);
  });

  it("reads each resource in the representation its webhooks carry, where a truncated delivery points", () => {
    const facts = { orderId: "ord_1", giftCardId: "gc_1", objectType: "custom.x" };
    for (const type of ["order", "product", "variant", "customer", "fulfillment", "shipment", "payment"] as const) {
      const { fetch } = eventDataTruncation(type, "res_1", facts);
      const operation = stable.find((candidate) => candidate.operationId === fetch.operationId);
      expect(operation, `${type}: ${fetch.operationId} is stable`).toBeDefined();
      expect(operation!.operationId.startsWith("dashboard.resources."), type).toBe(true);
      const template = new RegExp(`^${operation!.pathTemplate.replace(/\{[^}]+\}/gu, "[^/]+")}$`, "u");
      expect(fetch.path, type).toMatch(template);
      const output = JSON.stringify(operation!.outputSchema);
      expect(output.includes(`#/components/schemas/${type[0]!.toUpperCase()}${type.slice(1)}Resource`), type).toBe(true);
    }
  });

  it("seals no regional or editor-only product fields", () => {
    const sealed = JSON.stringify(currentSnapshot());
    for (const field of ["emiEligible", "freeDelivery", "discountPercentage", "discountType"]) {
      expect(sealed.includes(`"${field}"`), field).toBe(false);
    }
  });

  // One test, so `-u` cannot write the snapshot past a refused break.
  it("changes only additively against the committed snapshot, then matches it (accept an additive change with -u)", async () => {
    const committed = committedSnapshot();
    expect(committed, "stable-operations.snapshot.json is missing: create it with vitest run -u").not.toBeNull();
    const current = currentSnapshot();
    const text = `${JSON.stringify(current, null, 1)}\n`;
    const committedText = readFileSync(SNAPSHOT_FILE, "utf8");
    if (committedText !== text) {
      const open = unacknowledgedBreaks(SNAPSHOT_NAME, await snapshotFingerprint(committedText), stableBreakingChanges(committed!, current), acknowledgedBreaks());
      expect(open, `Breaking changes to the stable app API. Add a new operation instead, or (before the lock) add these entries with a reason to ${BREAKS_NAME}.`).toEqual([]);
    }
    await expect(text).toMatchFileSnapshot("./stable-operations.snapshot.json");
  });
});

describe("the breaking-change check", () => {
  const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
  const snapshot = (operation: Partial<StableOperationSnapshot>): StableSnapshot => ({
    operations: {
      "things.get": {
        operationId: "dashboard.things.get", method: "GET", path: "/api/v1/admin/things/{id}", risk: "read", idempotency: "none", revision: "none", scopes: ["read_products"],
        input: { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] },
        output: object({ id: { type: "string" }, status: { type: "string", enum: ["a", "b"] } }, ["id", "status"]),
        ...operation,
      },
    },
    components: {},
  });

  it("accepts additive changes", () => {
    const before = snapshot({});
    const after = snapshot({
      input: { parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "expand", in: "query", required: false, schema: { type: "string" } },
      ] },
      output: object({ id: { type: "string" }, status: { type: "string", enum: ["a", "b", "c"] }, note: { type: "string" } }, ["id", "status"]),
      scopes: ["read_products", "write_products"],
    });
    expect(stableBreakingChanges(before, after)).toEqual([]);
  });

  it("refuses removals, new requirements and narrower inputs", () => {
    const body = (schema: unknown) => ({ requestBody: { required: true, content: { "application/json": { schema } } } });
    const before = snapshot({ input: body(object({ tags: { type: "array", items: { type: "string", maxLength: 200 } }, kind: { type: "string", enum: ["x", "y"] } })) });
    const after = snapshot({
      input: body(object({ tags: { type: "array", items: { type: "string", maxLength: 100 } }, kind: { type: "string", enum: ["x"] }, owner: { type: "string" } }, ["owner"])),
      output: object({ id: { type: "string" } }, []),
      scopes: [],
      revision: "required",
    });
    const problems = stableBreakingChanges(before, after);
    expect(problems).toEqual(expect.arrayContaining([
      "things.get: the read_products scope no longer covers it.",
      "things.get: revision is now required.",
      "things.get input body.tags[]: maxLength tightened to 100.",
      'things.get input body.kind: no longer accepts "y".',
      "things.get input body.owner: a new required field.",
      "things.get output id: the field is no longer always present.",
      "things.get output status: the field was removed.",
    ]));
    expect(stableBreakingChanges(before, { operations: {}, components: {} }))
      .toEqual(["things.get: removed from the stable app API."]);
  });

  it("follows component references and matches union variants by their discriminator", () => {
    const section = (name: string, fields: Record<string, unknown>) => object({ section: { type: "string", enum: [name] }, ...fields }, ["section", ...Object.keys(fields)]);
    const before: StableSnapshot = {
      ...snapshot({ output: { oneOf: [section("base", { name: { type: "string" } }), section("media", { count: { $ref: "#/components/schemas/Count" } })] } }),
      components: { Count: { type: "integer" } },
    };
    const reordered: StableSnapshot = {
      ...snapshot({ output: { oneOf: [section("media", { count: { $ref: "#/components/schemas/Count" } }), section("base", { name: { type: "string" } }), section("seo", {})] } }),
      components: { Count: { type: "integer" } },
    };
    expect(stableBreakingChanges(before, reordered)).toEqual([]);
    const retyped: StableSnapshot = { ...reordered, components: { Count: { type: "string" } } };
    expect(stableBreakingChanges(before, retyped)).toEqual([
      "things.get output [variant 1].count: type changed from integer to string.",
    ]);
  });
});

describe("the money check", () => {
  const operation = (output: unknown, body?: unknown) => ({
    operationId: "dashboard.things.get",
    inputSchema: body ? { requestBody: { content: { "application/json": { schema: body } } } } : {},
    outputSchema: output,
  }) as unknown as AgentOperationManifestEntry;
  const object = (properties: Record<string, unknown>) => ({ type: "object", properties });

  it("refuses decimal amounts and returned amounts without a currency", () => {
    expect(moneyProblems([operation(
      object({ price: { type: "number" }, totalMinor: { type: "integer" }, pagination: object({ total: { type: "integer" }, totalPages: { type: "integer" } }) }),
      object({ shippingCharge: { type: "number" } }),
    )], {})).toEqual([
      "dashboard.things.get input shippingCharge: money is an integer *Minor field.",
      "dashboard.things.get output price: money is an integer *Minor field.",
      "dashboard.things.get output totalMinor: no currency beside this amount.",
    ]);
  });

  it("accepts minor units beside a currency on the object or an enclosing one", () => {
    expect(moneyProblems([operation(
      object({ currency: { type: "string" }, totalMinor: { type: "integer" }, lines: { type: "array", items: object({ unitPriceMinor: { type: "integer" } }) } }),
      object({ cashReceivedMinor: { type: "integer" } }),
    )], {})).toEqual([]);
  });
});
