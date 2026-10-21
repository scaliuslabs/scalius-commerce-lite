// Declared reads of a function (packages/plugin-sdk/docs/apps.md, "Functions"): the
// app's own data a function needs, named in the manifest and resolved by the
// host in the checkout read batch it already runs, so a function stays pure
// (no I/O) and a store pays nothing for reads no app declares.
//
//   functions: [{ point: "cart.validate", reads: [
//     { as: "member",  object: "members",   key: "customer" },                  // record id = the buyer's id
//     { as: "company", object: "companies", key: { from: "member.company_id" } }, // one bounded hop
//     { as: "moq",     object: "moq",       key: "line.variantId", max: 100 },     // one record per cart SKU
//     { as: "fields",  customFields: ["product:min_qty"] },                         // the app's own fields on the cart's products
//   ] }]
//
// `input.reads[as]` is `{ revision, data } | null` for a single-key read and
// `Record<key, { revision, data }>` (records that exist) for a per-line read.
// Part of the versioned plugin API.

import { z } from "zod";
import { OBJECT_TYPE_PATTERN, type ObjectTypeDeclaration } from "./objects";

/** Reads one function declares. */
export const FUNCTION_READS_MAX = 4;
/** Record keys one read may ask for: one per cart line, so a full cart (99 lines) always fits. */
export const FUNCTION_READ_KEYS_PER_READ_MAX = 100;
/** The JSON size of one function's resolved reads. */
export const FUNCTION_READ_BYTES_MAX = 256 * 1024;
/** Fields one custom-field read names. */
export const FUNCTION_READ_CUSTOM_FIELDS_MAX = 10;

export const FUNCTION_READ_AS_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const ATTRIBUTE_KEY = /^attribute\.[a-z][a-z0-9_-]{0,47}$/;
const HOP = /^([a-z][a-z0-9_]{0,31})\.([a-z][a-z0-9_]{0,63})$/;
/** Owner types a custom-field read reaches, and the key it implies. */
export const FUNCTION_READ_CUSTOM_FIELD_OWNERS = { product: "line.productId", variant: "line.variantId", customer: "customer" } as const;
type CustomFieldReadOwner = keyof typeof FUNCTION_READ_CUSTOM_FIELD_OWNERS;
const CUSTOM_FIELD_NAME = /^(product|variant|customer):([a-z][a-z0-9_]{0,63})$/;

/**
 * What a read is keyed by:
 * - `customer`: the signed-in buyer's id (no record for a guest);
 * - `line.variantId` / `line.productId`: one record per distinct SKU or
 *   product in the cart, at most `max`;
 * - `attribute.<key>`: the value the buyer entered in one of the app's
 *   checkout attributes;
 * - `{ from: "<as>.<field>" }`: the id held in a field of an earlier
 *   single-key read of this function (one hop, never a chain).
 */
export const functionReadKeySchema = z.union([
  z.enum(["customer", "line.variantId", "line.productId"]),
  z.string().regex(ATTRIBUTE_KEY, "Use attribute.<checkout attribute key>."),
  z.object({ from: z.string().regex(HOP, "Use <as>.<field> of an earlier read.") }).strict(),
]);
export type FunctionReadKey = z.infer<typeof functionReadKeySchema>;

const as = z.string().regex(FUNCTION_READ_AS_PATTERN, "Use a short snake_case name.");
const max = z.number().int().min(1).max(FUNCTION_READ_KEYS_PER_READ_MAX);

export const functionReadDeclarationSchema = z.union([
  z.object({ as, object: z.string().regex(OBJECT_TYPE_PATTERN), key: functionReadKeySchema, max: max.optional() }).strict(),
  z.object({
    as,
    /** The app's own custom fields, `<owner>:<key>`, all on one owner type (product, variant or customer). */
    customFields: z.array(z.string().regex(CUSTOM_FIELD_NAME, "Use <product|variant|customer>:<field key>.")).min(1).max(FUNCTION_READ_CUSTOM_FIELDS_MAX),
    /** Implied by the owner type; when given, it must be that key. */
    key: functionReadKeySchema.optional(),
    max: max.optional(),
  }).strict(),
]);
export type FunctionReadDeclaration = z.infer<typeof functionReadDeclarationSchema>;
export type FunctionObjectRead = Extract<FunctionReadDeclaration, { object: string }>;
export type FunctionCustomFieldsRead = Extract<FunctionReadDeclaration, { customFields: string[] }>;

/** One read record: an object record's revision (custom fields have none: 0) and its data in the SDK's wire form. */
export const functionReadRecordSchema = z.object({
  revision: z.number().int().min(0),
  data: z.record(z.string(), z.unknown()),
}).strict();
export type FunctionReadRecord = z.infer<typeof functionReadRecordSchema>;

/** `input.reads`: by `as`, a single-key read's record (or null) or a per-line read's records by key. */
export const functionReadsSchema = z.record(
  z.string().regex(FUNCTION_READ_AS_PATTERN),
  z.union([functionReadRecordSchema.nullable(), z.record(z.string().min(1).max(128), functionReadRecordSchema)]),
);
export type FunctionReads = z.infer<typeof functionReadsSchema>;

export function isCustomFieldsRead(read: FunctionReadDeclaration): read is FunctionCustomFieldsRead {
  return "customFields" in read;
}

/** The custom fields a read names, split into owner type and key. */
export function customFieldsReadFields(read: FunctionCustomFieldsRead): Array<{ ownerType: CustomFieldReadOwner; key: string }> {
  return read.customFields.map((name) => {
    const match = CUSTOM_FIELD_NAME.exec(name)!;
    return { ownerType: match[1] as CustomFieldReadOwner, key: match[2]! };
  });
}

/** The key a read resolves by (a custom-field read's comes from its owner type). */
export function functionReadKey(read: FunctionReadDeclaration): FunctionReadKey {
  if (!isCustomFieldsRead(read)) return read.key;
  const owner = customFieldsReadFields(read)[0]!.ownerType;
  return FUNCTION_READ_CUSTOM_FIELD_OWNERS[owner];
}

/** Whether a read gives one record per cart line (`Record<key, …>`) rather than one record. */
export function isPerLineRead(read: FunctionReadDeclaration): boolean {
  const key = functionReadKey(read);
  return key === "line.variantId" || key === "line.productId";
}

/** The parsed hop of a `{ from }` key. */
export function functionReadHop(key: FunctionReadKey): { as: string; field: string } | null {
  if (typeof key !== "object") return null;
  const match = HOP.exec(key.from);
  return match ? { as: match[1]!, field: match[2]! } : null;
}

/** Field types a hop may follow: the id of a record of the hop's object. */
const HOP_FIELD_TYPES = new Set(["single_line_text", "object_reference"]);

/**
 * Cross-field rules of one function's reads against its manifest: declared
 * objects, custom fields and checkout attributes, a hop from an earlier
 * single-key object read, unique names.
 */
export function functionReadIssues(
  reads: readonly FunctionReadDeclaration[],
  manifest: {
    id: string;
    objects: Readonly<Record<string, Pick<ObjectTypeDeclaration, "fields">>>;
    customFields: ReadonlyArray<{ ownerType: string; key: string }>;
    attributes: readonly string[];
  },
): Array<{ path: (string | number)[]; message: string }> {
  const issues: Array<{ path: (string | number)[]; message: string }> = [];
  const seen = new Map<string, FunctionReadDeclaration>();
  reads.forEach((read, index) => {
    const issue = (path: (string | number)[], message: string) => issues.push({ path: [index, ...path], message });
    if (seen.has(read.as)) issue(["as"], `Read ${read.as} is declared twice.`);
    const key = functionReadKey(read);
    if (read.max !== undefined && !isPerLineRead(read)) issue(["max"], "Only a per-line read (line.variantId, line.productId) takes max.");
    if (typeof key === "string" && key.startsWith("attribute.") && !manifest.attributes.includes(key.slice("attribute.".length))) {
      issue(["key"], `Checkout attribute ${key.slice("attribute.".length)} is not declared in checkout.attributes.`);
    }
    if (isCustomFieldsRead(read)) {
      const fields = customFieldsReadFields(read);
      if (new Set(fields.map((field) => field.ownerType)).size > 1) issue(["customFields"], "One custom-field read names fields of one owner type.");
      for (const field of fields) {
        if (!manifest.customFields.some((declared) => declared.ownerType === field.ownerType && declared.key === field.key)) {
          issue(["customFields"], `Custom field ${field.ownerType}:${field.key} is not declared in customFields.`);
        }
      }
      if (read.key !== undefined && JSON.stringify(read.key) !== JSON.stringify(FUNCTION_READ_CUSTOM_FIELD_OWNERS[fields[0]!.ownerType])) {
        issue(["key"], `${fields[0]!.ownerType} fields are read by ${FUNCTION_READ_CUSTOM_FIELD_OWNERS[fields[0]!.ownerType]}.`);
      }
    } else {
      const object = manifest.objects[read.object];
      if (!object) issue(["object"], `Object type ${read.object} is not declared.`);
      const hop = functionReadHop(read.key);
      if (hop) {
        const source = seen.get(hop.as);
        if (!source || isCustomFieldsRead(source) || isPerLineRead(source) || functionReadHop(source.key)) {
          issue(["key", "from"], `A hop starts from an earlier single-key object read (customer or attribute), not ${hop.as}.`);
        } else {
          const field = manifest.objects[source.object]?.fields.find((candidate) => candidate.key === hop.field);
          if (!field || !HOP_FIELD_TYPES.has(field.type)) {
            issue(["key", "from"], `${hop.as}.${hop.field} must be a single_line_text or object_reference field of ${source.object}.`);
          } else if (field.type === "object_reference" && field.to !== `${manifest.id}.${read.object}`) {
            issue(["key", "from"], `${hop.as}.${hop.field} references ${field.to ?? "another type"}, not ${manifest.id}.${read.object}.`);
          }
        }
      }
    }
    seen.set(read.as, read);
  });
  return issues;
}
