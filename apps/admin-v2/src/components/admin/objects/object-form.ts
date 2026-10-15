// The content type form's editing model: a draft of the name, handle,
// field rows, display field and storefront access, converted to the API's
// bodies and checked with the same rules the API applies (the shared
// patterns). Pure; no React.
import {
  isCustomFieldKey,
  normalizeCustomFieldKey,
} from "@scalius/shared/custom-fields";
import { OBJECT_FIELDS_MAX, OBJECT_TYPE_PATTERN } from "@scalius/shared/plugins/objects";
import type {
  CreateObjectTypeBody,
  ObjectType,
  UpdateObjectTypeBody,
  ObjectField,
} from "~/lib/api-query-options/objects";

export const OBJECT_NAME_MAX = 80;
export const OBJECT_DESCRIPTION_MAX = 300;

export interface FieldRowDraft {
  /** Identity of the row while editing (its key can change). */
  rowId: string;
  name: string;
  key: string;
  /** The key follows the name until the merchant edits it. */
  keyEdited: boolean;
  /** The field is on the saved type: its key stays (entries are stored under it). */
  saved: boolean;
  type: ObjectField["type"];
  source?: ObjectField;
  indexed: boolean;
  to?: string;
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
  display: string;
  storefront: boolean;
  compoundIndexes: string[][];
}

let rowCounter = 0;
export const nextRowId = () => `row-${++rowCounter}`;

export function blankRow(): FieldRowDraft {
  return { rowId: nextRowId(), name: "", key: "", keyEdited: false, saved: false, indexed: false, type: "single_line_text", required: false, description: "" };
}

export function emptyTypeDraft(): TypeDraft {
  return { name: "", handle: "", handleEdited: false, description: "", fields: [blankRow()], display: "", storefront: false, compoundIndexes: [] };
}

export function typeDraftOf(definition: ObjectType): TypeDraft {
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
      type: field.type,
      source: field,
      indexed: definition.indexes.includes(field.key),
      to: field.to,
      required: field.required === true,
      description: field.description ?? "",
    })),
    display: definition.display ?? "",
    storefront: definition.storefront,
    compoundIndexes: definition.indexes.filter((index): index is string[] => Array.isArray(index)),
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
  if (creating && !OBJECT_TYPE_PATTERN.test(draft.handle.trim())) problems.handle = "handleInvalid";
  if (draft.fields.length === 0) problems.fields = "fieldsRequired";
  else if (draft.fields.length > OBJECT_FIELDS_MAX) problems.fields = "fieldsTooMany";
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

function fieldsOf(draft: TypeDraft): CreateObjectTypeBody["fields"] {
  return draft.fields.map((row) => {
    const { to: _to, description: _description, ...source } = row.source ?? {};
    return {
    ...source,
    ...(row.to && (row.type === "object_reference" || row.type === "list.object_reference") ? { to: row.to } : {}),
    validations: row.source?.validations ?? {},
    key: row.key.trim(),
    name: row.name.trim(),
    type: row.type,
    required: row.required,
    ...(row.description.trim() ? { description: row.description.trim() } : {}),
    };
  });
}

/** The display field to send: only one that is still a field of the type. */
function displayOf(draft: TypeDraft): string | undefined {
  const key = draft.display.trim();
  return key && draft.fields.some((row) => row.key.trim() === key) ? key : undefined;
}

export function createTypeBody(draft: TypeDraft): CreateObjectTypeBody {
  const display = displayOf(draft);
  return {
    type: draft.handle.trim(),
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    fields: fieldsOf(draft),
    indexes: [...draft.compoundIndexes.filter((index) => index.every((key) => draft.fields.some((field) => field.key === key))), ...draft.fields.filter((field) => field.indexed).map((field) => field.key.trim())],
    ...(display ? { display } : {}),
    admin: "edit",
    handle: true,
    storefront: draft.storefront,
  };
}

export function updateTypeBody(draft: TypeDraft, expectedRevision: number, current: ObjectType): UpdateObjectTypeBody {
  const { type: _type, admin: _admin, handle: _handle, ...rest } = createTypeBody(draft);
  return { ...rest, expectedRevision, unique: current.unique, admin: current.admin, events: current.events, handle: current.handleEnabled };
}
