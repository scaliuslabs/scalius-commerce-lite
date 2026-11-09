// `sample`: a schema-valid representation of the stable app API, for the
// answers a `createContractApi` handler returns. Every field comes from the
// sealed contract the handler's answer is checked against, so a test states
// only the fields it cares about and keeps passing when the platform adds a
// field (a new nullable field is null, a new list empty):
//
//   "orders.get": () => ({ order: sample("order", { id: "ord_1", lines: [{ title: "Pen", quantity: 1 }] }) })
//
// Overrides merge into nested objects (contact, addresses, a line); a list
// replaces the sample's, and each object in it is completed from the list's
// item schema. The result is checked against the schema, so an override the
// platform would never return fails with the schema's message.

import type { EventRepresentation, EventRepresentationType } from "@scalius/shared/events";
import { contractSchemaIssue, stableContract, type ContractSchema, type StableContract } from "./testing-contract";

/**
 * The contract schema each representation type is: the `data` of a webhook
 * about that resource, as the stable read its truncation hint names answers
 * it. A new representation type fails to compile until it is named here.
 */
export const SAMPLE_REPRESENTATION_SCHEMAS = {
  order: "OrderResource",
  return: "ReturnResource",
  product: "ProductResource",
  variant: "VariantResource",
  customer: "CustomerResource",
  purchase_order: "PurchaseOrderResource",
  inventory_transfer: "InventoryTransferResource",
  fulfillment: "FulfillmentResource",
  refund: "RefundResource",
  shipment: "ShipmentResource",
  payment: "PaymentResource",
  checkout: "AbandonedCheckout",
  discount: "DiscountSummary",
  review: "ReviewResource",
  conversation: "ConversationResource",
  payout: "PayoutResource",
  gift_card: "GiftCardResource",
  gift_card_transaction: "GiftCardTransactionResource",
  object: "ObjectRecord",
  warranty: "WarrantyResource",
} as const satisfies Record<EventRepresentationType, string>;

/** A representation type `sample` builds and types as its `EventRepresentation`. */
export type SampleRepresentationType = keyof typeof SAMPLE_REPRESENTATION_SCHEMAS;

/** What `sample` takes for a value of type `T`: any part of it, objects merged field by field, a list replaced (its objects completed). */
export type SampleOverrides<T> = T extends readonly (infer Item)[]
  ? Array<SampleOverrides<Item>>
  : T extends object ? { [Key in keyof T]?: SampleOverrides<T[Key]> } : T;

const SAMPLE_INSTANT = "2026-01-01T00:00:00.000Z";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function resolve(schema: unknown, contract: StableContract): ContractSchema | null {
  let current = schema;
  for (let depth = 0; isRecord(current) && typeof current.$ref === "string" && depth < 16; depth += 1) {
    current = contract.components[current.$ref.replace(/^#\/components\/schemas\//, "")];
  }
  return isRecord(current) ? current : null;
}

const objectLike = (schema: ContractSchema) => schema.type === "object" || isRecord(schema.properties) || Array.isArray(schema.required);

/** The first text that fits: the format's, the field's name, then neutral ones, padded and cut to the length limits. */
function text(schema: ContractSchema, key: string, contract: StableContract): string {
  const min = typeof schema.minLength === "number" ? schema.minLength : 0;
  const max = typeof schema.maxLength === "number" ? schema.maxLength : Number.POSITIVE_INFINITY;
  const preferred = schema.format === "date-time" ? [SAMPLE_INSTANT]
    : schema.format === "uri" ? ["https://example.com"]
      // A three-letter code is a currency (the harness store's), a two-letter one a country.
      : min === 3 && max === 3 ? ["BDT"] : min === 2 && max === 2 ? ["BD"] : [];
  const candidates = [...preferred, key, "sample", "2026-01-01", SAMPLE_INSTANT].filter(Boolean).map((value) => value.padEnd(min, "x").slice(0, max));
  return candidates.find((value) => contractSchemaIssue(schema, value, contract) === null) ?? candidates[0]!;
}

function number(schema: ContractSchema): number {
  const step = schema.type === "integer" ? 1 : 0.5;
  let value = 0;
  if (typeof schema.minimum === "number") value = Math.max(value, schema.exclusiveMinimum === true ? schema.minimum + step : schema.minimum);
  if (typeof schema.exclusiveMinimum === "number") value = Math.max(value, schema.exclusiveMinimum + step);
  if (typeof schema.maximum === "number") value = Math.min(value, schema.exclusiveMaximum === true ? schema.maximum - step : schema.maximum);
  if (typeof schema.exclusiveMaximum === "number") value = Math.min(value, schema.exclusiveMaximum - step);
  return schema.type === "integer" ? Math.ceil(value) : value;
}

/** The schema's sample with `override` merged in. `undefined` takes the sample; a nullable value without an override is null. */
function build(schemaInput: unknown, override: unknown, key: string, contract: StableContract): unknown {
  const schema = resolve(schemaInput, contract);
  if (!schema) return override;
  if (override === undefined && (schema.nullable === true || (Array.isArray(schema.enum) && schema.enum.includes(null)))) return null;
  if (override === null) return null;
  for (const keyword of ["anyOf", "oneOf"] as const) {
    if (!Array.isArray(schema[keyword])) continue;
    // The first alternative the override completes into.
    const built = (schema[keyword] as unknown[]).map((part) => build(part, override, key, contract));
    return built.find((value) => contractSchemaIssue(schema, value, contract) === null) ?? built[0];
  }
  if (Array.isArray(schema.allOf)) {
    const parts = (schema.allOf as unknown[]).map((part) => build(part, override, key, contract));
    return parts.every(isRecord) ? Object.assign({}, ...parts) : parts[0];
  }
  if (override === undefined && schema.default !== undefined && contractSchemaIssue(schema, schema.default, contract) === null) return structuredClone(schema.default);
  if (Array.isArray(schema.enum)) return override === undefined ? schema.enum.find((option) => option !== null) : override;
  switch (schema.type) {
    case "string":
      return override === undefined ? text(schema, key, contract) : override;
    case "integer":
    case "number":
      return override === undefined ? number(schema) : override;
    case "boolean":
      return override === undefined ? false : override;
    case "array": {
      if (override === undefined) {
        const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
        return Array.from({ length: minItems }, () => build(schema.items, undefined, key, contract));
      }
      return Array.isArray(override) ? override.map((item) => build(schema.items, item, key, contract)) : override;
    }
    default: {
      if (!objectLike(schema)) return override;
      if (override !== undefined && !isRecord(override)) return override;
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const value: Record<string, unknown> = {};
      for (const required of Array.isArray(schema.required) ? schema.required as string[] : []) {
        value[required] = build(properties[required], undefined, required, contract);
      }
      for (const [name, item] of Object.entries(override ?? {})) {
        if (item === undefined) continue;
        const itemSchema = name in properties ? properties[name] : isRecord(schema.additionalProperties) ? schema.additionalProperties : undefined;
        value[name] = build(itemSchema, item, name, contract);
      }
      return value;
    }
  }
}

/**
 * A complete, schema-valid representation, for a `createContractApi`
 * handler's answer: by its representation type (`order`, `refund`,
 * `product`, …, typed as its `EventRepresentation`) or any schema of the
 * stable contract by name (`BrandResource`, see `stableContract.components`).
 *
 *   sample("order", { id: "ord_1", status: "confirmed", lines: [{ productId: "prod_pen", quantity: 1 }] })
 *
 * Defaults come from the sealed schema: a nullable field is null, a list is
 * empty, an enum takes its first value, a number its lowest allowed, a time
 * 2026-01-01T00:00:00.000Z, a currency BDT. Throws with the schema's message
 * when the overrides make a shape the platform never returns.
 */
export function sample<T extends SampleRepresentationType>(type: T, overrides?: SampleOverrides<EventRepresentation<T>>, contract?: StableContract): EventRepresentation<T>;
export function sample(schema: string, overrides?: Record<string, unknown>, contract?: StableContract): Record<string, unknown>;
export function sample(name: string, overrides: unknown = {}, contract: StableContract = stableContract): unknown {
  const schemaName = Object.hasOwn(SAMPLE_REPRESENTATION_SCHEMAS, name) ? SAMPLE_REPRESENTATION_SCHEMAS[name as SampleRepresentationType] : name;
  const schema = Object.hasOwn(contract.components, schemaName) ? contract.components[schemaName] : undefined;
  if (!schema) {
    throw new Error(`sample: ${JSON.stringify(name)} is neither a representation type (${Object.keys(SAMPLE_REPRESENTATION_SCHEMAS).join(", ")}) nor a schema of the stable contract (see stableContract.components).`);
  }
  if (!isRecord(overrides)) throw new Error(`sample("${name}"): overrides are an object of the fields to set.`);
  const value = build(schema, overrides, name, contract);
  const issue = contractSchemaIssue(schema, value, contract);
  if (issue) throw new Error(`sample("${name}"): ${issue.path || "the value"} ${issue.message}.`);
  return value;
}
