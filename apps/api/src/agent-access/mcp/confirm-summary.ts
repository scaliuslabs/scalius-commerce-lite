// What the owner reads before approving an agent's change: written by the
// platform from the operation's declared schema, never ordered or worded by
// the caller, and kept as DATA: a list of typed rows, each rendered by the
// approval page under its own fixed label, so no value can make a row.
// - `change`: the operation (its registry summary and id);
// - `money`: every money field the input carries (x-scalius-money), as a
//   formatted amount with its ISO currency code, first and never dropped (a
//   long list is summed, not cut);
// - `target`: the records the change names, by id (filters are refused for
//   gated changes: ./confirm.ts filterSelectionOf);
// - `setting`: the change's other numbers, flags and codes;
// - `words`: free text the agent supplied, labelled as its own words;
// - `note`: the platform's own remarks (parts not shown, money fields changed).
// Every text value has control, line-break and Unicode format (direction
// override, zero-width) characters removed and is bounded, visibly cut.
import { AGENT_COMPONENT_SCHEMAS, AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import { moneyFieldsOf } from "../../openapi/operation-registry/money-fields";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { moneyMarkerOf, type MoneyFieldMarker } from "@scalius/shared/money-field";
import type { ConfirmStep } from "./confirm";
import { countedNoun, isConfirmGated } from "./confirm";
import { containsStepReference } from "./references";
import { cleanSummaryText, summaryText, type SummaryNoteCode, type SummaryRow, type SummaryRowKind } from "../summary-rows";
import { approvalInputFields, isUnshownApprovalField, type ApprovalInputField } from "@scalius/shared/agent-approval";

/** The currencies an approval needs that the input alone does not name. */
export interface SummaryCurrencies {
  store?: string;
  /** Keyed by operation id: the order's or market's currency the change is in. */
  byOperation?: Readonly<Record<string, string>>;
}

export const CONFIRM_SUMMARY_MAX_ROWS = 60;
const LIST_SHOWN = 6;
const ID_KEY = /^(?:id|ids)$|Ids?$/;
const CURRENCY_KEY = /^(?:currency|currencyCode|[a-z]+Currency|[a-z]+CurrencyCode)$/;

interface Leaf {
  /** `body.items.*.unitPriceMinor`: array positions as `*`. */
  path: string;
  value: unknown;
  /** The object holding the value, for a currency named beside it. */
  parent: Record<string, unknown> | null;
}

function leaves(value: unknown, path: string, parent: Record<string, unknown> | null, out: Leaf[]): void {
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== "object")) {
      out.push({ path, value, parent });
      return;
    }
    for (const item of value) leaves(item, `${path}.*`, parent, out);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (item && typeof item === "object") leaves(item, `${path}.${key}`, record, out);
      else out.push({ path: `${path}.${key}`, value: item, parent: record });
    }
    return;
  }
  out.push({ path, value, parent });
}

function keyOf(path: string): string {
  return path.split(".").filter((segment) => segment !== "*").at(-1) ?? path;
}

function namedCurrency(parent: Record<string, unknown> | null): string | null {
  if (!parent) return null;
  for (const [key, value] of Object.entries(parent)) {
    if (CURRENCY_KEY.test(key) && typeof value === "string" && /^[A-Z]{3}$/.test(value)) return value;
  }
  return null;
}

function decimalsOf(code: string | null): number {
  if (!code) return 2;
  try {
    return getDecimalPlaces(code);
  } catch {
    return 2;
  }
}

function currencyOf(marker: MoneyFieldMarker, parent: Record<string, unknown> | null, operationId: string, currencies: SummaryCurrencies): string | null {
  if (marker.currency === "named") return namedCurrency(parent);
  if (marker.currency === "store") return currencies.store ?? null;
  return currencies.byOperation?.[operationId] ?? null;
}

/** An amount in major units, formatted at its currency's decimals. */
function majorText(value: number, unit: MoneyFieldMarker["unit"], code: string | null): string {
  const decimals = decimalsOf(code);
  return (unit === "minor" ? value / 10 ** decimals : value).toFixed(decimals);
}

function fieldLabel(path: string): string {
  return cleanSummaryText(path.replace(/^(?:body|query)\./, ""), 120);
}

function isWords(value: unknown): value is string {
  return typeof value === "string" && (/\s/.test(value) || value.length > 40 || /[^A-Za-z0-9_.:@+-]/.test(value));
}

function scalarText(value: unknown): string {
  if (Array.isArray(value)) {
    const shown = value.slice(0, LIST_SHOWN).map((item) => JSON.stringify(item)).join(", ");
    return value.length > LIST_SHOWN ? `[${shown}, and ${value.length - LIST_SHOWN} more]` : `[${shown}]`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A value as the page words it, by what the schema says the field holds. */
function valueRow(value: unknown, field: ApprovalInputField | undefined): Pick<SummaryRow, "value" | "type"> {
  if (value === null || value === undefined) return { value: null, type: "empty" };
  if (typeof value === "boolean") return { value, type: "boolean" };
  if (typeof value === "number") return { value, type: "number" };
  if (typeof value === "string") return { value: cleanSummaryText(value), type: field?.enumValues ? "enum" : "text" };
  return { value: cleanSummaryText(JSON.stringify(value)), type: "text" };
}

function noteText(code: SummaryNoteCode, field: string | null, count?: number): string {
  switch (code) {
    case "more_values": return `${count} more values of ${field} not shown`;
    case "more_texts": return `${count} more texts in ${field} not shown`;
    case "more_rows": return `${count} more settings or texts of the request not shown`;
    case "money_field": return `Changes money fields: ${field}`;
    case "step_reference": return "Some values come from earlier steps and are not known yet";
    case "body_not_shown": return `The request carries a ${count}-byte body this page cannot show`;
  }
}

/** A note row: the platform's own remark, worded by its code. */
export function noteRow(operationId: string, code: SummaryNoteCode, field: string | null = null, count?: number): SummaryRow {
  return { kind: "note", operationId, field, text: noteText(code, field, count), code, ...(count !== undefined ? { count } : {}) };
}

function stepRows(step: ConfirmStep, currencies: SummaryCurrencies): { head: SummaryRow[]; tail: SummaryRow[] } {
  const { operation, input } = step;
  const operationId = operation.operationId;
  const row = (kind: SummaryRowKind, field: string | null, text: string, extra: Partial<SummaryRow> = {}): SummaryRow =>
    ({ kind, operationId, field, text: cleanSummaryText(text), ...extra });
  const entry = AGENT_OPERATIONS_BY_ID[operationId];
  const fields = new Map(entry ? approvalInputFields(entry.inputSchema, AGENT_COMPONENT_SCHEMAS).map((field) => [field.path, field]) : []);
  const all: Leaf[] = [];
  if (input.body !== undefined) leaves(input.body, "body", null, all);
  if (input.query) leaves(input.query, "query", null, all);

  const head: SummaryRow[] = [row("change", null, operation.summary || operationId)];
  for (const pointer of step.changedMoneyFields ?? []) {
    head.push(noteRow(operationId, "money_field", pointer.replace(/^\/(?:body|query|path)\//, "").replace(/\//g, ".")));
  }

  // Money first, every field the schema declares, whoever ordered the body.
  const shown = new Set<Leaf>();
  const seen = new Set<string>();
  for (const field of entry ? moneyFieldsOf(entry.inputSchema, AGENT_COMPONENT_SCHEMAS) : []) {
    const marker = moneyMarkerOf(field.schema);
    // A field union variants share is one field.
    if (!marker || seen.has(field.path)) continue;
    seen.add(field.path);
    const found = all.filter((leaf) => leaf.path === field.path && leaf.value !== undefined && leaf.value !== null);
    if (found.length === 0) continue;
    found.forEach((leaf) => shown.add(leaf));
    const label = fieldLabel(field.path);
    const code = currencyOf(marker, found[0]!.parent, operationId, currencies);
    const numbers = found.map((leaf) => leaf.value).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (numbers.length !== found.length) {
      head.push(row("money", label, `not a number: ${found.map((leaf) => scalarText(leaf.value)).join(", ")}`, { currency: code }));
      continue;
    }
    if (found.length <= LIST_SHOWN) {
      for (const value of numbers) head.push(row("money", label, "", { amount: majorText(value, marker.unit, code), currency: code }));
      continue;
    }
    const total = numbers.reduce((sum, value) => sum + value, 0);
    const text = `${numbers.length} amounts, lowest ${majorText(Math.min(...numbers), marker.unit, code)}, highest ${majorText(Math.max(...numbers), marker.unit, code)}`;
    head.push(row("money", label, text, { amount: majorText(total, marker.unit, code), currency: code, count: numbers.length }));
  }

  for (const [key, value] of Object.entries(input.path ?? {})) {
    if (isUnshownApprovalField(`path.${key}`)) continue;
    head.push(row("target", key, String(value), { value: cleanSummaryText(String(value), 64), type: "id" }));
  }
  const tail: SummaryRow[] = [];
  const byPath = new Map<string, Leaf[]>();
  for (const leaf of all) {
    // Secrets, retry keys and the revisions a write checks bind the approval but are not shown.
    if (shown.has(leaf) || isUnshownApprovalField(leaf.path)) continue;
    byPath.set(leaf.path, [...(byPath.get(leaf.path) ?? []), leaf]);
  }
  for (const [path, found] of byPath) {
    const key = keyOf(path);
    const label = fieldLabel(path);
    const values = found.flatMap((leaf) => Array.isArray(leaf.value) ? leaf.value : [leaf.value]);
    if (ID_KEY.test(key)) {
      const ids = values.map(String);
      head.push(row("target", label, ids.length > LIST_SHOWN
        ? `${countedNoun(key, ids.length)}: ${ids.slice(0, LIST_SHOWN).join(", ")}, and ${ids.length - LIST_SHOWN} more`
        : ids.join(", "), { value: ids.length, type: "id" }));
      continue;
    }
    const field = fields.get(path) ?? fields.get(`${path}.*`);
    const textual = field?.enumValues ? [] : values.filter(isWords);
    if (textual.length > 0) {
      for (const text of textual.slice(0, LIST_SHOWN)) tail.push(row("words", label, text, { value: cleanSummaryText(text), type: "text" }));
      if (textual.length > LIST_SHOWN) tail.push(noteRow(operationId, "more_texts", label, textual.length - LIST_SHOWN));
      continue;
    }
    for (const value of values.slice(0, LIST_SHOWN)) tail.push(row("setting", label, scalarText(value), valueRow(value, field)));
    if (values.length > LIST_SHOWN) tail.push(noteRow(operationId, "more_values", label, values.length - LIST_SHOWN));
  }
  if (containsStepReference(input)) head.push(noteRow(operationId, "step_reference"));
  return { head, tail };
}

/**
 * The approval summary of the gated steps as rows: money and targets first
 * and never dropped, settings and the agent's words after them. Within
 * `CONFIRM_SUMMARY_MAX_ROWS`; rows that do not fit are counted in a note.
 */
export function confirmSummaryRows(steps: readonly ConfirmStep[], currencies: SummaryCurrencies = {}): SummaryRow[] {
  const gated = steps.filter((step) => isConfirmGated(step.operation, step.changedMoneyFields));
  const parts = gated.map((step) => stepRows(step, currencies));
  const head = parts.flatMap((part) => part.head);
  const tail = parts.flatMap((part) => part.tail);
  const room = Math.max(0, CONFIRM_SUMMARY_MAX_ROWS - head.length - 1);
  const rows = [...head, ...tail.slice(0, room)];
  if (tail.length > room) rows.push(noteRow(gated[0]?.operation.operationId ?? "", "more_rows", null, tail.length - room));
  return rows;
}

/** The summary text of the gated steps (rows rendered as lines). */
export function confirmSummary(steps: readonly ConfirmStep[], currencies: SummaryCurrencies = {}): string {
  return summaryText(confirmSummaryRows(steps, currencies));
}
