// The entry form's editing model: one text draft per field of the content
// type (the custom-field drafts, so every type reads and writes exactly as
// the Custom data card does), converted to the API's typed values and
// checked with the shared codec. Pure; no React.
import { OBJECT_HANDLE_PATTERN, type ObjectStatus, type ObjectField } from "@scalius/shared/plugins/objects";
import type { CustomFieldCodecContext, CustomFieldType, CustomFieldWireValue } from "@scalius/shared/custom-fields";
import {
  checkDraft,
  draftFromValue,
  sameDraft,
  valueFromDraft,
  type CustomFieldDraft,
  type DraftProblem,
} from "~/components/admin/custom-fields/custom-field-draft";
import type {
  CreateObjectRecordBody,
  ObjectType,
  ObjectRecord,
  UpdateObjectRecordBody,
} from "~/lib/api-query-options/objects";

export function objectFieldInputType(type: ObjectField["type"]): CustomFieldType {
  if (type === "list.object_reference") return "list.single_line_text";
  if (type === "object_reference" || type === "customer_reference" || type === "order_reference") return "single_line_text";
  return type;
}

export type EntryDrafts = Record<string, CustomFieldDraft>;

export interface EntryForm {
  handle: string;
  status: ObjectStatus;
  fields: EntryDrafts;
}

const emptyDraft = (type: CustomFieldType): CustomFieldDraft => draftFromValue(type, null);

export function entryFormOf(definition: ObjectType, entry: ObjectRecord | null): EntryForm {
  return {
    handle: entry?.handle ?? "",
    status: entry?.status ?? (definition.storefront ? "draft" : "active"),
    fields: Object.fromEntries(definition.fields.map((field) => {
      const stored = entry?.data[field.key];
      const type = objectFieldInputType(field.type);
      return [field.key, stored === undefined || stored === null ? emptyDraft(type) : draftFromValue(type, stored as CustomFieldWireValue)];
    })),
  };
}

/** A draft with nothing in it (blank text, a list of blank items). */
export function isEmptyDraft(draft: CustomFieldDraft): boolean {
  return Array.isArray(draft) ? draft.every((item) => item.trim() === "") : draft.trim() === "";
}

export function changedKeys(definition: ObjectType, form: EntryForm, base: EntryForm): string[] {
  return definition.fields
    .filter((field) => !sameDraft(form.fields[field.key] ?? "", base.fields[field.key] ?? ""))
    .map((field) => field.key);
}

export const sameEntryForm = (definition: ObjectType, form: EntryForm, base: EntryForm) =>
  form.handle.trim() === base.handle.trim() && form.status === base.status && changedKeys(definition, form, base).length === 0;

export type EntryProblem = { kind: "required" } | { kind: "value"; problem: DraftProblem };

export interface EntryProblems {
  handle?: "handleInvalid";
  /** By field key. */
  fields: Record<string, EntryProblem>;
}

/** What is wrong with the form for the API: unreadable values, and (to publish) empty required fields. */
export function entryProblems(definition: ObjectType, form: EntryForm, context: CustomFieldCodecContext): EntryProblems {
  const problems: EntryProblems = { fields: {} };
  if (form.handle.trim() && !OBJECT_HANDLE_PATTERN.test(form.handle.trim())) problems.handle = "handleInvalid";
  for (const field of definition.fields) {
    const draft = form.fields[field.key] ?? "";
    if (isEmptyDraft(draft)) {
      if (field.required && form.status !== "draft") problems.fields[field.key] = { kind: "required" };
      continue;
    }
    const problem = checkDraft({ type: objectFieldInputType(field.type), validations: field.validations ?? {} }, draft, context);
    if (problem) problems.fields[field.key] = { kind: "value", problem };
  }
  return problems;
}

export const hasEntryProblems = (problems: EntryProblems) => Boolean(problems.handle) || Object.keys(problems.fields).length > 0;

/** The value to send for a draft: null clears it. */
function valueOf(type: CustomFieldType, draft: CustomFieldDraft): unknown {
  if (isEmptyDraft(draft)) return null;
  return valueFromDraft(type, draft)?.value ?? null;
}

export function createEntryBody(definition: ObjectType, form: EntryForm): CreateObjectRecordBody {
  const data: Record<string, unknown> = {};
  for (const field of definition.fields) {
    const value = valueOf(objectFieldInputType(field.type), form.fields[field.key] ?? "");
    if (value !== null) data[field.key] = value;
  }
  return { data, expectedRevision: null, status: form.status, ...(definition.handleEnabled && form.handle.trim() ? { handle: form.handle.trim() } : {}) };
}

/** PUT replaces the complete record at the revision read. */
export function updateEntryBody(
  definition: ObjectType,
  form: EntryForm,
  _base: EntryForm,
  expectedRevision: number,
): UpdateObjectRecordBody {
  return { ...createEntryBody(definition, form), expectedRevision };
}
