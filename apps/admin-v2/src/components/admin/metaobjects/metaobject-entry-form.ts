// The entry form's editing model: one text draft per field of the content
// type (the custom-field drafts, so every type reads and writes exactly as
// the Custom data card does), converted to the API's typed values and
// checked with the shared codec. Pure; no React.
import { METAOBJECT_HANDLE_PATTERN, type MetaobjectEntryStatus } from "@scalius/shared/metaobjects";
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
  CreateMetaobjectEntryBody,
  MetaobjectDefinition,
  MetaobjectEntry,
  UpdateMetaobjectEntryBody,
} from "~/lib/api-query-options/metaobjects";

export type EntryDrafts = Record<string, CustomFieldDraft>;

export interface EntryForm {
  handle: string;
  status: MetaobjectEntryStatus;
  fields: EntryDrafts;
}

const emptyDraft = (type: CustomFieldType): CustomFieldDraft => draftFromValue(type, null);

export function entryFormOf(definition: MetaobjectDefinition, entry: MetaobjectEntry | null): EntryForm {
  return {
    handle: entry?.handle ?? "",
    status: entry?.status ?? "draft",
    fields: Object.fromEntries(definition.fields.map((field) => {
      const stored = entry?.fields[field.key];
      const type = field.type as CustomFieldType;
      return [field.key, stored === undefined || stored === null ? emptyDraft(type) : draftFromValue(type, stored as CustomFieldWireValue)];
    })),
  };
}

/** A draft with nothing in it (blank text, a list of blank items). */
export function isEmptyDraft(draft: CustomFieldDraft): boolean {
  return Array.isArray(draft) ? draft.every((item) => item.trim() === "") : draft.trim() === "";
}

export function changedKeys(definition: MetaobjectDefinition, form: EntryForm, base: EntryForm): string[] {
  return definition.fields
    .filter((field) => !sameDraft(form.fields[field.key] ?? "", base.fields[field.key] ?? ""))
    .map((field) => field.key);
}

export const sameEntryForm = (definition: MetaobjectDefinition, form: EntryForm, base: EntryForm) =>
  form.handle.trim() === base.handle.trim() && form.status === base.status && changedKeys(definition, form, base).length === 0;

export type EntryProblem = { kind: "required" } | { kind: "value"; problem: DraftProblem };

export interface EntryProblems {
  handle?: "handleInvalid";
  /** By field key. */
  fields: Record<string, EntryProblem>;
}

/** What is wrong with the form for the API: unreadable values, and (to publish) empty required fields. */
export function entryProblems(definition: MetaobjectDefinition, form: EntryForm, context: CustomFieldCodecContext): EntryProblems {
  const problems: EntryProblems = { fields: {} };
  if (form.handle.trim() && !METAOBJECT_HANDLE_PATTERN.test(form.handle.trim())) problems.handle = "handleInvalid";
  for (const field of definition.fields) {
    const draft = form.fields[field.key] ?? "";
    if (isEmptyDraft(draft)) {
      if (field.required && form.status === "published") problems.fields[field.key] = { kind: "required" };
      continue;
    }
    const problem = checkDraft({ type: field.type as CustomFieldType, validations: {} }, draft, context);
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

export function createEntryBody(definition: MetaobjectDefinition, form: EntryForm): CreateMetaobjectEntryBody {
  const fields: Record<string, unknown> = {};
  for (const field of definition.fields) {
    const value = valueOf(field.type as CustomFieldType, form.fields[field.key] ?? "");
    if (value !== null) fields[field.key] = value;
  }
  return { status: form.status, fields, ...(form.handle.trim() ? { handle: form.handle.trim() } : {}) };
}

/** Only what changed, at the revision read (a cleared field is sent as null). */
export function updateEntryBody(
  definition: MetaobjectDefinition,
  form: EntryForm,
  base: EntryForm,
  expectedRevision: number,
): UpdateMetaobjectEntryBody {
  const keys = changedKeys(definition, form, base);
  const fields: Record<string, unknown> = {};
  for (const field of definition.fields) {
    if (keys.includes(field.key)) fields[field.key] = valueOf(field.type as CustomFieldType, form.fields[field.key] ?? "");
  }
  return {
    expectedRevision,
    ...(keys.length > 0 ? { fields } : {}),
    ...(form.status !== base.status ? { status: form.status } : {}),
    ...(form.handle.trim() !== base.handle.trim() && form.handle.trim() ? { handle: form.handle.trim() } : {}),
  };
}
