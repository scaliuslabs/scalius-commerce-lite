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
import { cleanSummaryText, summaryText, type SummaryNoteCode, type SummaryRow, type SummaryRowKind, type SummaryValueType } from "../summary-rows";
import { approvalFieldDisposition, approvalIdRole, approvalInputFields, isApprovalIdField, secretTail, type ApprovalIdRole, type ApprovalInputField } from "@scalius/shared/agent-approval";

/** The currencies an approval needs that the input alone does not name. */
export interface SummaryCurrencies {
  store?: string;
  /** Keyed by operation id: the order's or market's currency the change is in. */
  byOperation?: Readonly<Record<string, string>>;
}

const LIST_SHOWN = 6;
const CURRENCY_KEY = /^(?:currency|currencyCode|[a-z]+Currency|[a-z]+CurrencyCode)$/;

interface Leaf {
  /** `body.items.*.unitPriceMinor`: array positions as `*`. */
  path: string;
  value: unknown;
  /** The object holding the value, for a currency named beside it. */
  parent: Record<string, unknown> | null;
  /** In a list of entries (an order's items): the entry, so the page shows one row per entry. */
  entry?: number;
}

function leaves(value: unknown, path: string, parent: Record<string, unknown> | null, out: Leaf[], entry?: number): void {
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== "object")) {
      out.push({ path, value, parent, ...(entry !== undefined ? { entry } : {}) });
      return;
    }
    // The outermost list of objects numbers its entries.
    value.forEach((item, index) => leaves(item, `${path}.*`, parent, out, entry ?? index));
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (item && typeof item === "object") leaves(item, `${path}.${key}`, record, out, entry);
      else out.push({ path: `${path}.${key}`, value: item, parent: record, ...(entry !== undefined ? { entry } : {}) });
    }
    return;
  }
  out.push({ path, value, parent, ...(entry !== undefined ? { entry } : {}) });
}

/** Each value's entry in its list, when the values sit in a list of entries. */
function entriesOf(found: readonly Leaf[]): { entries: number[] } | Record<string, never> {
  if (found.length === 0 || found.some((leaf) => leaf.entry === undefined)) return {};
  return { entries: found.flatMap((leaf) => Array.isArray(leaf.value) ? leaf.value.map(() => leaf.entry!) : [leaf.entry!]) };
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

/** A target row's record: the kind of record its ids name, `part` for a part of the record the change edits, nothing when unknown. */
function recordOf(role: ApprovalIdRole): Pick<SummaryRow, "record"> {
  if (role.role === "record") return { record: role.kind };
  return role.role === "part" ? { record: "part" } : {};
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

type RowValue = string | number | boolean | null;

/** A value as the page words it: a scalar, cleaned and bounded; anything else as JSON text. */
function rowValue(value: unknown): RowValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  return cleanSummaryText(typeof value === "string" ? value : JSON.stringify(value));
}

/** What the values are, by what the schema says the field holds. */
function valueType(values: readonly unknown[], field: ApprovalInputField | undefined): SummaryValueType {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return "empty";
  if (present.every((value) => typeof value === "boolean")) return "boolean";
  if (present.every((value) => typeof value === "number")) return "number";
  return field?.enumValues ? "enum" : "text";
}

function noteText(code: SummaryNoteCode, field: string | null, count?: number): string {
  switch (code) {
    case "money_field": return `Changes money fields: ${field}`;
    case "step_reference": return "Some values come from earlier steps and are not known yet";
    case "body_not_shown": return `The request carries a ${count}-byte body this page cannot show`;
  }
}

/** A note row: the platform's own remark, worded by its code. */
export function noteRow(operationId: string, code: SummaryNoteCode, field: string | null = null, count?: number): SummaryRow {
  return { kind: "note", operationId, field, text: noteText(code, field, count), code, ...(count !== undefined ? { count } : {}) };
}

function stepRows(step: ConfirmStep, currencies: SummaryCurrencies): SummaryRow[] {
  const { operation, input } = step;
  const operationId = operation.operationId;
  const row = (kind: SummaryRowKind, field: string | null, text: string, extra: Partial<SummaryRow> = {}): SummaryRow =>
    ({ kind, operationId, field, text: cleanSummaryText(text), ...extra });
  const entry = AGENT_OPERATIONS_BY_ID[operationId];
  const schemaFields = entry ? approvalInputFields(entry.inputSchema, AGENT_COMPONENT_SCHEMAS) : [];
  const fields = new Map(schemaFields.map((field) => [field.path, field]));
  // Rows follow the schema's order, never the order the agent wrote its body in.
  const order = new Map(schemaFields.map((field, index) => [field.path, index]));
  const fieldOf = (path: string) => fields.get(path) ?? fields.get(`${path}.*`);
  const disposition = (path: string) => fieldOf(path)?.disposition ?? approvalFieldDisposition(path);
  const all: Leaf[] = [];
  if (input.body !== undefined) leaves(input.body, "body", null, all);
  if (input.query) leaves(input.query, "query", null, all);

  const rows: SummaryRow[] = [row("change", null, operation.summary || operationId)];
  for (const pointer of step.changedMoneyFields ?? []) {
    rows.push(noteRow(operationId, "money_field", pointer.replace(/^\/(?:body|query|path)\//, "").replace(/\//g, ".")));
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
      // Not an amount: shown as such, and the change cannot be approved (no amount to read).
      rows.push(row("money", label, `not a number: ${found.map((leaf) => scalarText(leaf.value)).join(", ")}`, { currency: code }));
      continue;
    }
    if (found.length <= LIST_SHOWN) {
      found.forEach((leaf, index) => rows.push(row("money", label, "", {
        amount: majorText(numbers[index]!, marker.unit, code),
        currency: code,
        ...(leaf.entry !== undefined ? { entries: [leaf.entry] } : {}),
      })));
      continue;
    }
    const total = numbers.reduce((sum, value) => sum + value, 0);
    const text = `${numbers.length} amounts, lowest ${majorText(Math.min(...numbers), marker.unit, code)}, highest ${majorText(Math.max(...numbers), marker.unit, code)}`;
    rows.push(row("money", label, text, { amount: majorText(total, marker.unit, code), currency: code, count: numbers.length }));
  }

  // The records the change names: every id, the path's first, each with the kind of record it names.
  const settings: SummaryRow[] = [];
  for (const [key, value] of Object.entries(input.path ?? {})) {
    if (disposition(`path.${key}`) === "no_effect") continue;
    const text = cleanSummaryText(String(value), 64);
    const role = approvalIdRole(operation, `path.${key}`);
    if (role.role === "value") {
      settings.push(row("setting", `path.${key}`, text, { values: [text], type: "text" }));
      continue;
    }
    rows.push(row("target", `path.${key}`, text, { values: [text], type: "id", ...recordOf(role) }));
  }
  const byPath = new Map<string, Leaf[]>();
  for (const leaf of all) {
    if (shown.has(leaf) || disposition(leaf.path) === "no_effect") continue;
    byPath.set(leaf.path, [...(byPath.get(leaf.path) ?? []), leaf]);
  }
  const paths = [...byPath.keys()].sort((a, b) =>
    (order.get(a) ?? order.get(`${a}.*`) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? order.get(`${b}.*`) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
  const words: SummaryRow[] = [];
  for (const path of paths) {
    const found = byPath.get(path)!;
    const key = keyOf(path);
    const label = fieldLabel(path);
    const values = found.flatMap((leaf) => Array.isArray(leaf.value) ? leaf.value : [leaf.value]);
    if (disposition(path) === "masked") {
      settings.push(row("setting", label, "(secret)", { values: values.map((value) => secretTail(String(value ?? ""))), type: "masked" }));
      continue;
    }
    const entries = entriesOf(found);
    const role = isApprovalIdField(label) ? approvalIdRole(operation, label) : null;
    if (role && role.role !== "value" && values.every((value) => typeof value === "string" || typeof value === "number")) {
      const ids = values.map((value) => cleanSummaryText(String(value), 64));
      rows.push(row("target", label, ids.length > LIST_SHOWN ? `${countedNoun(key, ids.length)}: ${ids.join(", ")}` : ids.join(", "), { values: ids, type: "id", ...recordOf(role), ...entries }));
      continue;
    }
    const field = fieldOf(path);
    if (!field?.enumValues && values.some(isWords)) {
      for (const text of values.filter(isWords)) words.push(row("words", label, text, { values: [cleanSummaryText(text)], type: "text" }));
      const rest = values.filter((value) => !isWords(value));
      if (rest.length > 0) settings.push(row("setting", label, rest.map(scalarText).join(", "), { values: rest.map(rowValue), type: valueType(rest, field) }));
      continue;
    }
    settings.push(row("setting", label, values.map(scalarText).join(", "), { values: values.map(rowValue), type: valueType(values, field), ...entries }));
  }
  if (containsStepReference(input)) rows.push(noteRow(operationId, "step_reference"));
  // Settings in the schema's order, then the agent's own words, last.
  return [...rows, ...settings, ...words];
}

/**
 * The approval summary of the gated steps as rows: per step its operation,
 * money, the records it names, its settings and the agent's words, every
 * value of every field. What the stored approval cannot hold is counted in a
 * note (approvals.ts), and then the change cannot be approved.
 */
export function confirmSummaryRows(steps: readonly ConfirmStep[], currencies: SummaryCurrencies = {}): SummaryRow[] {
  return steps
    .filter((step) => isConfirmGated(step.operation, step.changedMoneyFields))
    .flatMap((step) => stepRows(step, currencies));
}

/** The summary text of the gated steps (rows rendered as lines). */
export function confirmSummary(steps: readonly ConfirmStep[], currencies: SummaryCurrencies = {}): string {
  return summaryText(confirmSummaryRows(steps, currencies));
}
