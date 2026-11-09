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
//     { as: "slot",    object: "slots", key: { join: ["attribute.day", "attribute.window"] } }, // record id `<day>:<window>`
//     { as: "open",    object: "slots", list: { where: { status: "open" }, orderBy: "starts_at", from: "now", limit: 20 } },
//   ] }]
//
// `input.reads[as]` is `{ revision, data } | null` for a single-key read,
// `Record<key, { revision, data }>` (records that exist) for a per-line read,
// and `Array<{ id, revision, data }>` in index order for a list read.
// Every run also gets `input.now`, the minute it started (`functionClock`):
// a function stays pure, and a list read `from: "now"` and the function see
// one clock.
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
/** Records one list read answers at most (they count toward the function's keys). */
export const FUNCTION_READ_LIST_MAX = 50;
/** Attributes one composite key joins, and the separator between their values. */
export const FUNCTION_READ_JOIN_MAX = 4;
export const FUNCTION_READ_JOIN_SEPARATOR = ":";

/**
 * The clock a run sees (`input.now`) and a list read `from: "now"` reads
 * by: the instant rounded down to the minute, ISO 8601 UTC. One request's
 * runs share it, and the same minute gives the same input.
 */
export function functionClock(at: number = Date.now()): string {
  return new Date(Math.floor(at / 60_000) * 60_000).toISOString().replace(".000Z", "Z");
}

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
 *   single-key read of this function (one hop, never a chain);
 * - `{ join: ["attribute.<a>", "attribute.<b>"] }`: 2 to 4 of the app's
 *   checkout attributes, their values joined by `:` (a day and a window
 *   name one slot); no record while any of them is empty.
 */
export const functionReadKeySchema = z.union([
  z.enum(["customer", "line.variantId", "line.productId"]),
  z.string().regex(ATTRIBUTE_KEY, "Use attribute.<checkout attribute key>."),
  z.object({ from: z.string().regex(HOP, "Use <as>.<field> of an earlier read.") }).strict(),
  z.object({
    join: z.array(z.string().regex(ATTRIBUTE_KEY, "Use attribute.<checkout attribute key>.")).min(2).max(FUNCTION_READ_JOIN_MAX),
  }).strict(),
]);
export type FunctionReadKey = z.infer<typeof functionReadKeySchema>;

const as = z.string().regex(FUNCTION_READ_AS_PATTERN, "Use a short snake_case name.");
const max = z.number().int().min(1).max(FUNCTION_READ_KEYS_PER_READ_MAX);

const listScalar = z.union([z.string().min(1).max(200), z.number().finite(), z.boolean()]);
/**
 * A list read: up to `limit` records of one of the app's object types, through
 * one declared index as `ctx.objects.query` reads it (`where`: equality on its
 * leading fields, `orderBy`: its next field). `from: "now"` starts at the
 * run's clock, on an `integer` (epoch milliseconds) or `date_time` order field.
 * Nothing in it comes from the buyer, so every checkout of a minute reads the same.
 */
export const functionListReadSchema = z.object({
  where: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), listScalar).optional(),
  orderBy: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  from: z.literal("now").optional(),
  limit: z.number().int().min(1).max(FUNCTION_READ_LIST_MAX),
}).strict();
export type FunctionListRead = z.infer<typeof functionListReadSchema>;

export const functionReadDeclarationSchema = z.union([
  z.object({ as, object: z.string().regex(OBJECT_TYPE_PATTERN), key: functionReadKeySchema, max: max.optional() }).strict(),
  z.object({ as, object: z.string().regex(OBJECT_TYPE_PATTERN), list: functionListReadSchema }).strict(),
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
export type FunctionObjectRead = Extract<FunctionReadDeclaration, { object: string; key: unknown }>;
export type FunctionObjectListRead = Extract<FunctionReadDeclaration, { list: unknown }>;
export type FunctionCustomFieldsRead = Extract<FunctionReadDeclaration, { customFields: string[] }>;

/** One read record: an object record's revision (custom fields have none: 0) and its data in the SDK's wire form. */
export const functionReadRecordSchema = z.object({
  revision: z.number().int().min(0),
  data: z.record(z.string(), z.unknown()),
}).strict();
export type FunctionReadRecord = z.infer<typeof functionReadRecordSchema>;

/** One record of a list read: its id beside the revision and data. */
export const functionListReadRecordSchema = functionReadRecordSchema.extend({ id: z.string().min(1).max(128) }).strict();
export type FunctionListReadRecord = z.infer<typeof functionListReadRecordSchema>;

/** `input.reads`: by `as`, a single-key read's record (or null), a per-line read's records by key, or a list read's records in order. */
export const functionReadsSchema = z.record(
  z.string().regex(FUNCTION_READ_AS_PATTERN),
  z.union([
    functionReadRecordSchema.nullable(),
    z.record(z.string().min(1).max(128), functionReadRecordSchema),
    z.array(functionListReadRecordSchema).max(FUNCTION_READ_LIST_MAX),
  ]),
);
export type FunctionReads = z.infer<typeof functionReadsSchema>;

export function isCustomFieldsRead(read: FunctionReadDeclaration): read is FunctionCustomFieldsRead {
  return "customFields" in read;
}

export function isListRead(read: FunctionReadDeclaration): read is FunctionObjectListRead {
  return "list" in read;
}

/** The attribute keys (without `attribute.`) a composite key joins, or null for another key. */
export function functionReadJoin(key: FunctionReadKey | null): string[] | null {
  return key && typeof key === "object" && "join" in key ? key.join.map((part) => part.slice("attribute.".length)) : null;
}

/** The custom fields a read names, split into owner type and key. */
export function customFieldsReadFields(read: FunctionCustomFieldsRead): Array<{ ownerType: CustomFieldReadOwner; key: string }> {
  return read.customFields.map((name) => {
    const match = CUSTOM_FIELD_NAME.exec(name)!;
    return { ownerType: match[1] as CustomFieldReadOwner, key: match[2]! };
  });
}

/** The key a read resolves by (a custom-field read's comes from its owner type); a list read has none. */
export function functionReadKey(read: FunctionReadDeclaration): FunctionReadKey | null {
  if (isListRead(read)) return null;
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
export function functionReadHop(key: FunctionReadKey | null): { as: string; field: string } | null {
  if (!key || typeof key !== "object" || !("from" in key)) return null;
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
    objects: Readonly<Record<string, Pick<ObjectTypeDeclaration, "fields"> & Partial<Pick<ObjectTypeDeclaration, "indexes">>>>;
    customFields: ReadonlyArray<{ ownerType: string; key: string }>;
    attributes: readonly string[];
  },
): Array<{ path: (string | number)[]; message: string }> {
  const issues: Array<{ path: (string | number)[]; message: string }> = [];
  const seen = new Map<string, FunctionReadDeclaration>();
  reads.forEach((read, index) => {
    const issue = (path: (string | number)[], message: string) => issues.push({ path: [index, ...path], message });
    if (seen.has(read.as)) issue(["as"], `Read ${read.as} is declared twice.`);
    if (isListRead(read)) {
      for (const message of listReadIssues(read, manifest.objects[read.object])) issue(["list"], message);
      if (!manifest.objects[read.object]) issue(["object"], `Object type ${read.object} is not declared.`);
      seen.set(read.as, read);
      return;
    }
    const key = functionReadKey(read);
    if ("max" in read && read.max !== undefined && !isPerLineRead(read)) issue(["max"], "Only a per-line read (line.variantId, line.productId) takes max.");
    for (const attribute of [
      ...(typeof key === "string" && key.startsWith("attribute.") ? [key.slice("attribute.".length)] : []),
      ...(functionReadJoin(key) ?? []),
    ]) {
      if (!manifest.attributes.includes(attribute)) issue(["key"], `Checkout attribute ${attribute} is not declared in checkout.attributes.`);
    }
    if (functionReadJoin(key) && new Set(functionReadJoin(key)).size !== functionReadJoin(key)!.length) issue(["key", "join"], "Join each attribute once.");
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
        if (!source || isCustomFieldsRead(source) || isListRead(source) || isPerLineRead(source) || functionReadHop(source.key)) {
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

/** Order field types a list read may start `from: "now"` on. */
const CLOCK_FIELD_TYPES = new Set(["integer", "date_time"]);

/**
 * A list read's own rules against its object's declaration: `where` names the
 * leading fields of one declared index (scalars only) and `orderBy` its next
 * field, as `ctx.objects.query` plans it; `from: "now"` orders by an
 * `integer` or `date_time` field.
 */
export function listReadIssues(
  read: FunctionObjectListRead,
  object: (Pick<ObjectTypeDeclaration, "fields"> & Partial<Pick<ObjectTypeDeclaration, "indexes">>) | undefined,
): string[] {
  if (!object) return [];
  const { where = {}, orderBy, from } = read.list;
  const whereFields = Object.keys(where);
  const issues: string[] = [];
  for (const field of [...whereFields, ...(orderBy ? [orderBy] : [])]) {
    if (!object.fields.some((entry) => entry.key === field)) issues.push(`${field} is not a field of ${read.object}.`);
  }
  if (from === "now") {
    const type = object.fields.find((entry) => entry.key === orderBy)?.type;
    if (!orderBy || !type || !CLOCK_FIELD_TYPES.has(type)) issues.push("A list read from now orders by an integer (epoch milliseconds) or date_time field.");
  }
  if (whereFields.length > 0 || orderBy) {
    const fits = (object.indexes ?? []).some((entry) => {
      const fields = typeof entry === "string" ? [entry] : [...entry];
      if (whereFields.length > fields.length || !whereFields.every((field) => fields.slice(0, whereFields.length).includes(field))) return false;
      return !orderBy || fields[whereFields.length] === orderBy;
    });
    if (!fits) issues.push(`Read through one declared index of ${read.object}: where names its leading fields, orderBy its next field.`);
  }
  return issues;
}
