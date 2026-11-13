// An approval summary as stored and shown: typed rows the approval page
// labels by kind, never by their text. Writing the rows needs the operation's
// schema (./mcp/confirm-summary.ts, on the agent dispatch path, where the
// manifest is loaded); reading, cleaning and rendering stored rows needs none,
// so the approvals runtime never loads the agent manifest.

import { APPROVAL_RECORD_KINDS, approvalFieldKey, approvalFieldParentKey, type ApprovalRecordKind } from "@scalius/shared/agent-approval";
import { APPROVAL_ACTIONS } from "@scalius/shared/agent-approval-actions";
import { APPROVAL_FIELDS } from "@scalius/shared/agent-approval-fields";
import { APPROVAL_VALUES } from "@scalius/shared/agent-approval-values";

export const SUMMARY_ROW_KINDS = ["change", "money", "target", "setting", "words", "note"] as const;
export type SummaryRowKind = (typeof SUMMARY_ROW_KINDS)[number];

/** What a setting's value is, so the page words it (an enum by its label, a boolean as a statement). */
export const SUMMARY_VALUE_TYPES = ["enum", "text", "number", "boolean", "id", "empty", "masked"] as const;
export type SummaryValueType = (typeof SUMMARY_VALUE_TYPES)[number];

/** What a note says; the page words it by its code, never by its text. */
export const SUMMARY_NOTE_CODES = ["money_field", "step_reference", "body_not_shown"] as const;
export type SummaryNoteCode = (typeof SUMMARY_NOTE_CODES)[number];

/**
 * One row of an approval summary. The page labels it by `kind` and its
 * field (the dashboard's approval vocabulary), and words its `value` by
 * `type`; `text` is the plain-text form for the agent and the CLI.
 */
export interface SummaryRow {
  kind: SummaryRowKind;
  /** The operation the row belongs to. */
  operationId: string;
  /** The input field it shows (`amount`, `set.*.prices.*.amount`), or null. */
  field: string | null;
  /** The value, cleaned and bounded, as plain text: a title, ids, a setting's value, the agent's words. */
  text: string;
  /** Money rows: the amount in major units, formatted (`99999.00`). */
  amount?: string;
  /** Money rows: the ISO 4217 code, or null when it cannot be resolved. */
  currency?: string | null;
  /** Setting, target and words rows: every value the field carries (a target row: its ids; a secret: its last characters). */
  values?: Array<string | number | boolean | null>;
  type?: SummaryValueType;
  /** Note rows: what the note says, and its number (rows not shown, bytes). Money rows: how many amounts a total sums. */
  code?: SummaryNoteCode;
  count?: number;
  /** Target rows: the kind of store record its ids name (the page names each), or `part` for a part of the record the change edits. */
  record?: ApprovalRecordKind | "part";
  /** Rows of a list's entries (`items.*.quantity`): each value's entry, so the page shows one row per entry. */
  entries?: number[];
}

/** Notes that mean a person cannot see the whole change. */
const INCOMPLETE_NOTES: ReadonlySet<SummaryNoteCode> = new Set(["step_reference", "body_not_shown"]);

/**
 * Why these rows do not show the whole change, or [] when they do: values
 * from earlier steps or a body the page cannot show, and an amount without its
 * currency (a change too large to keep whole is refused before it is stored). Such a change cannot be approved (the page
 * offers only Decline, and the approve endpoint refuses it).
 */
export function incompleteSummaryReasons(rows: readonly SummaryRow[]): string[] {
  const reasons: string[] = [];
  for (const row of rows) {
    if (row.kind === "note" && row.code && INCOMPLETE_NOTES.has(row.code)) reasons.push(row.code);
    if (row.kind === "money" && (!row.currency || !row.amount)) reasons.push(`money_unclear:${row.field ?? ""}`);
  }
  if (!rows.some((row) => row.kind === "change")) reasons.push("no_change");
  return reasons;
}

/** The kinds of record an approval names by the name staff know them by (approvals.ts reads the names). */
export const CONFIRM_TARGET_KINDS = APPROVAL_RECORD_KINDS;

export const SUMMARY_TEXT_MAX = 240;
/** Control characters, line and paragraph separators, and Unicode format characters (direction overrides, zero-width). */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** A text value as the page may show it: one line, no direction tricks, visibly cut. */
export function cleanSummaryText(value: string, max = SUMMARY_TEXT_MAX): string {
  const text = value.replace(UNSAFE_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}… (cut, ${text.length} characters)` : text;
}

/** The English label of a field, from the approval page's own vocabulary (its parent and key first). */
function fieldWords(field: string | null): string {
  if (!field) return "Note";
  const labels = APPROVAL_FIELDS.en;
  const parent = approvalFieldParentKey(field);
  if (parent && Object.hasOwn(labels, parent)) return labels[parent]!;
  const key = approvalFieldKey(field);
  return Object.hasOwn(labels, key) ? labels[key]! : key;
}

/** A value in English: a listed value by its label, yes or no, else as it is. */
function valueWords(field: string | null, value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const text = String(value);
  if (field) {
    const values = APPROVAL_VALUES.en;
    const parent = approvalFieldParentKey(field);
    if (parent && Object.hasOwn(values, `${parent}=${text}`)) return values[`${parent}=${text}`]!;
    const key = approvalFieldKey(field);
    if (Object.hasOwn(values, `${key}=${text}`)) return values[`${key}=${text}`]!;
  }
  return text;
}

/** A record named by its name, its id beside, when the page could read it. */
type RecordNames = ReadonlyMap<string, string | null>;

/**
 * The rows as one plain text, for the agent and the CLI, in the approval
 * page's own English words (its action phrases and field labels, never the
 * input's field names), with the records it names by name once they are read.
 */
export function summaryText(rows: readonly SummaryRow[], targets: ReadonlyArray<{ records: ReadonlyArray<{ id: string; name: string | null }> }> = []): string {
  const names: RecordNames = new Map(targets.flatMap((target) => target.records.map((record) => [record.id, record.name] as const)));
  const named = (id: string) => names.get(id) ? `${names.get(id)} (${id})` : id;
  return rows.map((row) => {
    switch (row.kind) {
      case "change":
        return `Wants to: ${APPROVAL_ACTIONS.en[row.operationId] ?? row.text} (${row.operationId})`;
      case "money": {
        const amount = `${row.amount ?? ""} ${row.currency ?? "(currency unknown)"}`.trim();
        return `${fieldWords(row.field)}: ${row.count ? `${amount} in all, across ${row.count} amounts` : amount}${row.text && !row.count ? ` (${row.text})` : ""}`;
      }
      case "target": {
        const ids = (row.values ?? []).map(String);
        return `${fieldWords(row.field)}: ${ids.length > 0 ? ids.map(named).join(", ") : row.text}`;
      }
      case "words":
        return `${fieldWords(row.field)} (the agent's own words, not checked by Scalius): ${JSON.stringify(typeof row.values?.[0] === "string" ? row.values[0] : row.text)}`;
      case "setting": {
        const values = row.values ?? [];
        return `${fieldWords(row.field)}: ${values.length > 0 ? (row.type === "masked" ? values.map((tail) => `a secret ending in ${String(tail)}`) : values.map((value) => valueWords(row.field, value))).join(", ") : row.text}`;
      }
      case "note":
        return `Note: ${row.text}`;
    }
  }).join("\n");
}
