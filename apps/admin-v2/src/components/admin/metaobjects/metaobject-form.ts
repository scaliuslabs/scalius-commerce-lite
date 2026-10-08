// The content type form's editing model: a draft of the name, handle,
// field rows, display field and storefront access, converted to the API's
// bodies and checked with the same rules the API applies (the shared
// patterns). Pure; no React.
import {
  isCustomFieldKey,
  normalizeCustomFieldKey,
  type CustomFieldType,
} from "@scalius/shared/custom-fields";
import { METAOBJECT_FIELDS_MAX } from "@scalius/shared/metaobjects";
import type {
  CreateMetaobjectDefinitionBody,
  MetaobjectDefinition,
  UpdateMetaobjectDefinitionBody,
} from "~/lib/api-query-options/metaobjects";

export const METAOBJECT_NAME_MAX = 80;
export const METAOBJECT_DESCRIPTION_MAX = 300;

export interface FieldRowDraft {
  /** Identity of the row while editing (its key can change). */
  rowId: string;
  name: string;
  key: string;
  /** The key follows the name until the merchant edits it. */
  keyEdited: boolean;
  /** The field is on the saved type: its key stays (entries are stored under it). */
  saved: boolean;
  type: CustomFieldType;
  required: boolean;
  description: string;
}

export interface TypeDraft {
  name: string;
  /** The type handle (`faq` of `custom.faq`), fixed once created. */
  handle: string;
  handleEdited: boolean;
  description: string;
  fields: FieldRowDraft[];
  /** A field key; "" lets the first text field name entries. */
  displayField: string;
  storefrontAccess: boolean;
}

let rowCounter = 0;
export const nextRowId = () => `row-${++rowCounter}`;

export function blankRow(): FieldRowDraft {
  return { rowId: nextRowId(), name: "", key: "", keyEdited: false, saved: false, type: "single_line_text", required: false, description: "" };
}

export function emptyTypeDraft(): TypeDraft {
  return { name: "", handle: "", handleEdited: false, description: "", fields: [blankRow()], displayField: "", storefrontAccess: false };
}

export function typeDraftOf(definition: MetaobjectDefinition): TypeDraft {
  return {
    name: definition.name,
    handle: definition.type,
    handleEdited: true,
    description: definition.description ?? "",
    fields: definition.fields.map((field) => ({
      rowId: nextRowId(),
      name: field.name,
      key: field.key,
      keyEdited: true,
      saved: true,
      type: field.type as CustomFieldType,
      required: field.required === true,
      description: field.description ?? "",
    })),
    displayField: definition.displayField ?? "",
    storefrontAccess: definition.storefrontAccess,
  };
}

/** What a draft would save: the draft without row identities, to tell edits from none. */
export function typeDraftSnapshot(draft: TypeDraft): string {
  return JSON.stringify({ ...draft, fields: draft.fields.map(({ rowId: _rowId, ...field }) => field) });
}

/** A key from free text that none of `taken` uses ("title", "title_2", …). */
export function uniqueKey(name: string, taken: readonly string[]): string {
  const base = normalizeCustomFieldKey(name);
  if (!base) return "";
  if (!taken.includes(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base.slice(0, 60)}_${index}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return base;
}

/** The draft after the name changed: the handle follows it until edited. */
export function withName(draft: TypeDraft, name: string): TypeDraft {
  return { ...draft, name, handle: draft.handleEdited ? draft.handle : normalizeCustomFieldKey(name) ?? "" };
}

/** A row after its name changed: its key follows the name until edited (unless saved). */
export function withRowName(draft: TypeDraft, rowId: string, name: string): TypeDraft {
  return {
    ...draft,
    fields: draft.fields.map((row) => {
      if (row.rowId !== rowId) return row;
      if (row.saved || row.keyEdited) return { ...row, name };
      const taken = draft.fields.filter((other) => other.rowId !== rowId).map((other) => other.key);
      return { ...row, name, key: uniqueKey(name, taken) };
    }),
  };
}

export function moveRow(fields: readonly FieldRowDraft[], index: number, by: -1 | 1): FieldRowDraft[] {
  const target = index + by;
  if (target < 0 || target >= fields.length) return [...fields];
  const next = [...fields];
  const [row] = next.splice(index, 1);
  next.splice(target, 0, row!);
  return next;
}

export type TypeProblemCode =
  | "nameRequired"
  | "handleInvalid"
  | "fieldsRequired"
  | "fieldsTooMany"
  | "fieldNameRequired"
  | "fieldKeyInvalid"
  | "fieldKeyTaken";

export interface TypeProblems {
  name?: TypeProblemCode;
  handle?: TypeProblemCode;
  fields?: TypeProblemCode;
  /** By row id. */
  rows: Record<string, { name?: TypeProblemCode; key?: TypeProblemCode }>;
}

export function typeDraftProblems(draft: TypeDraft, creating: boolean): TypeProblems {
  const problems: TypeProblems = { rows: {} };
  if (!draft.name.trim()) problems.name = "nameRequired";
  if (creating && !isCustomFieldKey(draft.handle.trim())) problems.handle = "handleInvalid";
  if (draft.fields.length === 0) problems.fields = "fieldsRequired";
  else if (draft.fields.length > METAOBJECT_FIELDS_MAX) problems.fields = "fieldsTooMany";
  const seen = new Set<string>();
  for (const row of draft.fields) {
    const found: { name?: TypeProblemCode; key?: TypeProblemCode } = {};
    if (!row.name.trim()) found.name = "fieldNameRequired";
    const key = row.key.trim();
    if (!isCustomFieldKey(key)) found.key = "fieldKeyInvalid";
    else if (seen.has(key)) found.key = "fieldKeyTaken";
    seen.add(key);
    if (found.name || found.key) problems.rows[row.rowId] = found;
  }
  return problems;
}

export const hasTypeProblems = (problems: TypeProblems) =>
  Boolean(problems.name || problems.handle || problems.fields || Object.keys(problems.rows).length > 0);

function fieldsOf(draft: TypeDraft): CreateMetaobjectDefinitionBody["fields"] {
  return draft.fields.map((row) => ({
    key: row.key.trim(),
    name: row.name.trim(),
    type: row.type,
    required: row.required,
    ...(row.description.trim() ? { description: row.description.trim() } : {}),
  }));
}

/** The display field to send: only one that is still a field of the type. */
function displayFieldOf(draft: TypeDraft): string | undefined {
  const key = draft.displayField.trim();
  return key && draft.fields.some((row) => row.key.trim() === key) ? key : undefined;
}

export function createTypeBody(draft: TypeDraft): CreateMetaobjectDefinitionBody {
  const displayField = displayFieldOf(draft);
  return {
    type: draft.handle.trim(),
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    fields: fieldsOf(draft),
    ...(displayField ? { displayField } : {}),
    storefrontAccess: draft.storefrontAccess,
  };
}

export function updateTypeBody(draft: TypeDraft, expectedRevision: number): UpdateMetaobjectDefinitionBody {
  const { type: _type, ...rest } = createTypeBody(draft);
  return { ...rest, expectedRevision };
}
