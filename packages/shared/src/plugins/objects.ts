/** Typed records shared by apps, merchant content and the storefront. */
import { z } from "zod";
import {
  CUSTOM_FIELD_TYPES, customFieldWireValue, parseCustomFieldValue, parseCustomFieldValidations,
  type CustomFieldCodecContext, type CustomFieldType,
} from "../custom-fields";
import { PLUGIN_ID_PATTERN } from "./ids";
import { PLUGIN_FIELD_KEY_PATTERN, PLUGIN_FIELD_KEY_RULE, PLUGIN_OBJECT_TYPE_PATTERN, PLUGIN_OBJECT_TYPE_RULE } from "./manifest-patterns";

export const OBJECT_MERCHANT_NAMESPACE = "custom";
export const OBJECT_TYPE_ID_PREFIX = "oty_";
export const OBJECT_RECORD_ID_PREFIX = "obj_";
/** The manifest's identifier rule (manifest-patterns.ts): object types and field keys are snake_case. */
export const OBJECT_TYPE_PATTERN = PLUGIN_OBJECT_TYPE_PATTERN;
export const OBJECT_FIELD_KEY_PATTERN = PLUGIN_FIELD_KEY_PATTERN;
export const OBJECT_HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
export const OBJECT_TYPES_MAX = 100;
export const OBJECT_FIELDS_MAX = 40;
export const OBJECT_SECTION_RECORDS_MAX = 24;
export const OBJECT_RECORD_MAX_BYTES = 64 * 1024;
/** One full record plus envelope; list pages share this bounded transport ceiling. */
export const OBJECT_OPERATION_RESPONSE_MAX_BYTES = 128 * 1024;
export const OBJECT_STATUSES = ["active", "draft", "published"] as const;
export type ObjectStatus = (typeof OBJECT_STATUSES)[number];
export const OBJECT_FIELD_TYPES = [...CUSTOM_FIELD_TYPES, "customer_reference", "order_reference"] as const;

export function objectTypeId(namespace: string, type: string): string { return `${OBJECT_TYPE_ID_PREFIX}${namespace}.${type}`; }
export function objectTypeHandle(namespace: string, type: string): string { return `${namespace}.${type}`; }
export function parseObjectTypeHandle(handle: string): { namespace: string; type: string } | null {
  const split = handle.lastIndexOf(".");
  const namespace = handle.slice(0, split);
  const type = handle.slice(split + 1);
  return split > 0 && OBJECT_TYPE_PATTERN.test(type) && (namespace === OBJECT_MERCHANT_NAMESPACE || PLUGIN_ID_PATTERN.test(namespace))
    ? { namespace, type } : null;
}

const validationsSchema = z.object({
  min: z.union([z.string(), z.number()]).nullable().optional(),
  max: z.union([z.string(), z.number()]).nullable().optional(),
  regex: z.string().max(200).nullable().optional(),
  choices: z.array(z.string()).max(128).nullable().optional(),
}).strict();

export const objectFieldSchema = z.object({
  key: z.string().regex(OBJECT_FIELD_KEY_PATTERN, PLUGIN_FIELD_KEY_RULE),
  name: z.string().trim().min(1).max(80),
  type: z.enum(OBJECT_FIELD_TYPES),
  to: z.string().refine((value) => parseObjectTypeHandle(value) !== null, "Use a qualified object type.").optional(),
  required: z.boolean().default(false),
  description: z.string().trim().max(300).optional(),
  validations: validationsSchema.default({}),
}).strict().superRefine((field, context) => {
  const reference = field.type === "object_reference" || field.type === "list.object_reference";
  if (reference !== Boolean(field.to)) context.addIssue({ code: "custom", path: ["to"], message: reference ? "Choose the referenced object type." : "Only object references declare a target type." });
});
export type ObjectField = z.output<typeof objectFieldSchema>;
const fieldKey = z.string().regex(OBJECT_FIELD_KEY_PATTERN, PLUGIN_FIELD_KEY_RULE);
/**
 * One field (`"order_id"`) or up to four in order (`["order_id"]`,
 * `["customer_id", "created_at"]`); a one-field list reads as the field.
 */
const indexSchema = z.union([
  fieldKey,
  z.array(fieldKey).min(1).max(4).refine((keys) => new Set(keys).size === keys.length, "An index names each field once.")
    .transform((keys) => (keys.length === 1 ? keys[0]! : keys)),
]);
const declarationShape = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  fields: z.array(objectFieldSchema).min(1).max(OBJECT_FIELDS_MAX),
  display: fieldKey.optional(),
  /** Query paths (`ctx.objects.<type>.query`): equality on an index's leading fields, ordered by its next one. */
  indexes: z.array(indexSchema).max(4).default([]),
  /** Unique field sets; each one also answers an exact lookup on all its fields, with no index slot of its own. */
  unique: z.array(indexSchema).max(2).default([]),
  handle: z.boolean().default(false),
  storefront: z.boolean().default(false),
  admin: z.enum(["none", "read", "edit"]).optional(),
  events: z.boolean().default(false),
};
function checkDeclaration(value: { fields: ObjectField[]; display?: string; indexes: (string | string[])[]; unique: (string | string[])[] }, context: z.RefinementCtx) {
  const fields = new Map(value.fields.map((field) => [field.key, field]));
  if (fields.size !== value.fields.length) context.addIssue({ code: "custom", path: ["fields"], message: "Each field key appears once." });
  if (value.display && !fields.has(value.display)) context.addIssue({ code: "custom", path: ["display"], message: "Choose a declared display field." });
  for (const kind of ["indexes", "unique"] as const) {
    const seen = new Set<string>();
    value[kind].forEach((index, position) => {
      const keys = typeof index === "string" ? [index] : index;
      const identity = keys.join("\0");
      if (seen.has(identity)) context.addIssue({ code: "custom", path: [kind, position], message: "Declare an index once." });
      seen.add(identity);
      for (const key of keys) {
        const field = fields.get(key);
        if (!field || field.type === "json" || field.type.startsWith("list.")) context.addIssue({ code: "custom", path: [kind, position], message: `${key} must name a scalar or reference field.` });
      }
    });
  }
}
export const objectTypeDeclarationSchema = z.object(declarationShape).strict().superRefine(checkDeclaration);
export const objectTypeInputSchema = z.object({ type: z.string().regex(OBJECT_TYPE_PATTERN, PLUGIN_OBJECT_TYPE_RULE), ...declarationShape }).strict().superRefine(checkDeclaration);
export type ObjectTypeDeclaration = z.output<typeof objectTypeDeclarationSchema>;
export type ObjectTypeInput = z.input<typeof objectTypeInputSchema>;

export interface ObjectTypeView {
  id: string;
  handle: string;
  namespace: string;
  type: string;
  name: string;
  description: string | null;
  fields: ObjectField[];
  indexes: Array<string | string[]>;
  unique: Array<string | string[]>;
  display: string | null;
  storefront: boolean;
  admin: "none" | "read" | "edit";
  events: boolean;
  handleEnabled: boolean;
  owner: "merchant" | "app";
  recordCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ObjectRecordView {
  id: string;
  typeId: string;
  handle: string | null;
  displayName: string;
  status: ObjectStatus;
  data: Record<string, unknown>;
  position: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Existing codec semantics, with weak references sharing its reference validation. */
function codecType(field: ObjectField): CustomFieldType {
  if (field.type === "list.object_reference") return "list.product_reference";
  if (["customer_reference", "order_reference", "object_reference"].includes(field.type)) return "product_reference";
  return field.type as CustomFieldType;
}
export interface ObjectDataIssue { key: string; message: string }
export function prepareObjectData(
  declaration: Pick<ObjectTypeDeclaration, "fields">,
  input: Record<string, unknown>,
  context: CustomFieldCodecContext,
  status: ObjectStatus = "active",
): { ok: true; data: Record<string, unknown> } | { ok: false; issues: ObjectDataIssue[] } {
  const fields = new Map(declaration.fields.map((field) => [field.key, field]));
  const issues: ObjectDataIssue[] = [];
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(input)) if (!fields.has(key)) issues.push({ key, message: "Unknown object field." });
  for (const field of declaration.fields) {
    const type = codecType(field);
    const validations = parseCustomFieldValidations(type, field.validations, context);
    if (!validations.ok) { issues.push({ key: field.key, message: validations.issue.message }); continue; }
    const value = parseCustomFieldValue({ type, validations: validations.value }, input[field.key] ?? null, context);
    if (!value.ok) { issues.push({ key: field.key, message: value.issue.message }); continue; }
    if (value.value === null) {
      if (field.required && status !== "draft") issues.push({ key: field.key, message: "This field is required." });
      continue;
    }
    data[field.key] = type === "money" ? Number(value.value)
      : type === "list.money" ? (JSON.parse(value.value) as string[]).map(Number)
      : customFieldWireValue(type, value.value, context);
  }
  return issues.length ? { ok: false, issues } : { ok: true, data };
}

/** Money is stored in minor units; HTTP/SDK values use the shared codec's wire units. */
export function objectDataWire(declaration: Pick<ObjectTypeDeclaration, "fields">, stored: Record<string, unknown>, context: CustomFieldCodecContext): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of declaration.fields) {
    const value = stored[field.key];
    if (value === undefined) continue;
    data[field.key] = field.type === "money" ? customFieldWireValue("money", String(value), context)
      : field.type === "list.money" ? customFieldWireValue("list.money", JSON.stringify((value as unknown[]).map(String)), context) : value;
  }
  return data;
}

export function objectHandleFrom(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100).replace(/-+$/g, "") || "record";
}

/** The bounded projection carried by product, order and customer admin detail reads. */
export interface RelatedObjectRecord {
  typeId: string;
  typeHandle: string;
  typeName: string;
  recordId: string;
  displayName: string;
}
